import { expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Frame, Page } from "playwright-core";
import { removeDir } from "../src/server/testutil";
import { after, api, before, bookId, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let plugins = "";

const NOTES = Array.from({ length: 200 }, (_, i) => `row ${i + 1} of the notes`).join("\n");
const TRAP_BOOK = "the bytes of a book that a hostile plugin is given";

/** A plugin that does everything an isolated plugin must not be able to do, and writes down what happened. */
const TRAP = `
export async function mount(host, context) {
  const out = {};
  const attempt = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = "blocked: " + ((e && e.name) || String(e));
    }
  };
  await attempt("origin", () => window.origin);
  await attempt("cookie", () => (document.cookie === "" ? "empty" : "readable"));
  await attempt("parent", () => (window.parent.document ? "reachable" : "none"));
  await attempt("storage", () => (localStorage.setItem("x", "1"), "writable"));
  await attempt("api", async () => "read " + (await fetch("/api/library", { credentials: "include" })).status);
  await attempt("outside", async () => "read " + (await fetch("https://example.com/")).status);
  await attempt("top", () => ((window.top.location.href = "/#hacked"), "no error"));
  await attempt("popup", () => (window.open("/", "_blank") ? "opened" : "null"));
  await attempt("file", async () => "bytes " + (await context.file()).byteLength);
  const pre = document.createElement("pre");
  pre.id = "out";
  pre.textContent = JSON.stringify(out);
  host.replaceChildren(pre);
  return { destroy() {} };
}
`;

before(async () => {
  browser = await launch();
  // the isolated example that comes with the repository, a hostile one, and one whose reader breaks
  plugins = mkdtempSync(join(tmpdir(), "reader-e2e-isolated-"));
  cpSync(join(import.meta.dir, "..", "plugins-example", "text-lines-sandboxed"), join(plugins, "text-lines-sandboxed"), { recursive: true });
  for (const [id, ext, reader] of [["trap", "trap", TRAP], ["breaks", "breaks", 'export function mount() { throw new Error("the plugin broke while opening"); }']] as const) {
    mkdirSync(join(plugins, id));
    writeFileSync(join(plugins, id, "plugin.json"), JSON.stringify({ id, name: id, api: 2, isolated: true, formats: [{ ext }], reader: "reader.js" }));
    writeFileSync(join(plugins, id, "reader.js"), reader);
  }
  inst = await startServer({ "Notes.slines": NOTES, "Case.trap": TRAP_BOOK, "Bad.breaks": "x" }, { TAPALOG_PLUGINS: plugins });
  await setup(inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
  removeDir(plugins);
});

/** The frame of an isolated plugin on the page (its address is the program's own /plugin-host/ page). */
const pluginFrame = async (page: Page): Promise<Frame> => {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().includes("/plugin-host/"));
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error("the plugin's frame never appeared");
};

/** Runs something in the plugin's frame, again in the next one if the book was opened twice and the first frame was replaced. */
const inFrame = async <T>(page: Page, run: (frame: Frame) => Promise<T>): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      return await run(await pluginFrame(page));
    } catch (e) {
      if (i > 5 || !/detached|destroyed|closed/i.test(String(e))) throw e;
    }
  }
};

e2e("an isolated plugin reads a book in a sandboxed frame: place, share link and cover all work", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  const id = await bookId(ctx, inst, "Notes.slines");
  await page.goto(`${inst.url}/#book=${id}`);
  await inFrame(page, (frame) => frame.waitForSelector(".text-lines li"));
  const frame = await pluginFrame(page);
  expect(await frame.locator(".text-lines li").count()).toBe(200); // the bytes came by message
  expect(await frame.locator(".text-lines li").first().textContent()).toBe("row 1 of the notes");
  expect(await frame.getAttribute(".text-lines", "data-api")).toBe("2");
  expect(await page.getAttribute("iframe[src*='/plugin-host/']", "sandbox")).toBe("allow-scripts"); // nothing else is allowed

  // the place the plugin reports reaches the program (the label too), and a share link carries it
  await frame.evaluate(() => (document.querySelector(".text-lines") as HTMLElement).scrollTo(0, 3000));
  await page.waitForTimeout(1200);
  const made = await api<{ token: string }>(ctx, inst, "/api/shares", { bookId: id, view: { line: 100 }, expiresInDays: 1 });
  const shared = await (await browser.newContext()).newPage(); // someone who is not signed in
  const sharedErrors = watchErrors(shared);
  await shared.goto(`${inst.url}/s/${made.token}`);
  await inFrame(shared, (f) => f.waitForSelector(".text-lines li"));
  await inFrame(shared, (f) => f.waitForFunction(() => (document.querySelector(".text-lines") as HTMLElement).scrollTop > 1000)); // opened at its line, not at the top
  expect(sharedErrors).toEqual([]);

  // closing the book removes the frame
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  expect(page.frames().some((f) => f.url().includes("/plugin-host/"))).toBe(false);

  // the plugin draws the cover, in a hidden frame that is gone afterwards
  await page.waitForSelector(`.thumb[data-cover-id="${id}"] img`);
  expect(readdirSync(join(inst.data, "covers")).some((name) => name.endsWith(".jpg"))).toBe(true);
  expect(page.frames().some((f) => f.url().includes("/plugin-host/"))).toBe(false);
  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("what an isolated plugin tries is refused: no cookies, no page, no storage, no login, no other sites, no navigation", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const id = await bookId(ctx, inst, "Case.trap");
  const opened = ctx.pages().length;
  await page.goto(`${inst.url}/#book=${id}`);
  const result = JSON.parse((await inFrame(page, async (frame) => (await frame.waitForSelector("#out", { timeout: 30_000 }), frame.textContent("#out"))))!) as Record<string, string>;

  expect(result.origin).toBe("null"); // an origin of its own that nothing else shares
  expect(result.cookie).toStartWith("blocked: SecurityError");
  expect(result.parent).toStartWith("blocked: SecurityError");
  expect(result.storage).toStartWith("blocked: SecurityError");
  expect(result.api).toStartWith("blocked: TypeError"); // sent as a stranger: no login, and the answer is not readable
  expect(result.outside).toStartWith("blocked: TypeError"); // the policy of the frame allows only the program's own address
  expect(result.popup).toBe("null");
  expect(result.file).toBe(`bytes ${new TextEncoder().encode(TRAP_BOOK).length}`); // what it is given, it gets

  await page.waitForTimeout(500);
  expect(page.url()).toBe(`${inst.url}/#book=${id}`); // the page was not navigated away by the plugin
  expect(ctx.pages().length).toBe(opened); // and no window was opened
  await ctx.close();
});

e2e("a plugin that breaks while opening is told to the reader like any other, and the frame goes away", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  await page.goto(`${inst.url}/#book=${await bookId(ctx, inst, "Bad.breaks")}`);
  await page.waitForSelector("text=The reader plugin could not open this book");
  await page.waitForSelector("text=the plugin broke while opening");
  expect(page.frames().some((f) => f.url().includes("/plugin-host/"))).toBe(false);
  await ctx.close();
});
