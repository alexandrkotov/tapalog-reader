import { expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../src/server/testutil";
import type { Browser } from "playwright-core";
import { after, api, before, bookId, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let plugins = "";

const NOTES = Array.from({ length: 200 }, (_, i) => `row ${i + 1} of the notes`).join("\n");

before(async () => {
  browser = await launch();
  // the example plugin that comes with the repository reads ".lines" files, which the program itself knows nothing about;
  // beside it, one written for a contract newer than this program's
  plugins = mkdtempSync(join(tmpdir(), "reader-e2e-plugins-"));
  cpSync(join(import.meta.dir, "..", "plugins-example", "text-lines"), join(plugins, "text-lines"), { recursive: true });
  mkdirSync(join(plugins, "from-the-future"));
  writeFileSync(join(plugins, "from-the-future", "plugin.json"), JSON.stringify({ id: "from-the-future", name: "From the future", api: 3, formats: [{ ext: "fut" }], reader: "reader.js" }));
  writeFileSync(join(plugins, "from-the-future", "reader.js"), "export function mount() {}");
  inst = await startServer({ "Notes.lines": NOTES, "Plain.txt": "an ordinary text book, read by the built-in reader" }, { TAPALOG_PLUGINS: plugins });
  await setup(inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
  removeDir(plugins);
});

e2e("a book in a format only a plugin knows is listed, read by the plugin and shared at its place", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  const id = await bookId(ctx, inst, "Notes.lines");
  await page.goto(`${inst.url}/#book=${id}`);
  await page.waitForSelector(".text-lines li");
  expect(await page.locator(".text-lines li").count()).toBe(200);
  expect(await page.locator(".text-lines li").first().textContent()).toBe("row 1 of the notes");
  expect(await page.getAttribute(".text-lines", "data-api")).toBe("1"); // the plugin is told which version of the contract it is given

  // the plugin's own view (a line) goes into a bookmark and a share link, and comes back when they are opened
  await page.evaluate(() => (document.querySelector(".text-lines") as HTMLElement).scrollTo(0, 3000));
  await page.waitForTimeout(500);
  const made = await api<{ token: string }>(ctx, inst, "/api/shares", { bookId: id, view: { line: 100 }, expiresInDays: 1 });
  const shared = await (await browser.newContext()).newPage(); // someone who is not signed in
  const sharedErrors = watchErrors(shared);
  await shared.goto(`${inst.url}/s/${made.token}`);
  await shared.waitForSelector(".text-lines li");
  await shared.waitForFunction(() => (document.querySelector(".text-lines") as HTMLElement).scrollTop > 1000); // opened at its line, not at the top
  expect(sharedErrors).toEqual([]);

  // the plugin draws the book's cover, which the library shows (drawn by the administrator's browser, as for built-in formats)
  await page.goto(inst.url + "/");
  await page.waitForSelector(`.thumb[data-cover-id="${id}"] img`);
  expect(readdirSync(join(inst.data, "covers")).some((name) => name.endsWith(".jpg"))).toBe(true);
  expect(await page.locator(".shelf .thumb img").count()).toBe(1); // the text book has none: a tile with its format

  // a built-in format is still read by the built-in reader
  await page.goto(`${inst.url}/#book=${await bookId(ctx, inst, "Plain.txt")}`);
  await page.waitForSelector(".txt-body");
  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("the administrator can see which plugins are installed", async () => {
  const ctx = await signedIn(browser, inst);
  const listed = await api<{ api: number; plugins: { id: string; exts: string[]; api: number }[]; problems: { folder: string; problem: string }[] }>(ctx, inst, "/api/admin/plugins");
  expect(listed.api).toBe(2);
  expect(listed.plugins.map((p) => [p.id, p.exts, p.api])).toEqual([["text-lines", ["lines"], 1]]);
  expect(listed.problems).toEqual([{ folder: "from-the-future", problem: "it is written for plugin API 3, and this program has 2: a newer version of the program is needed" }]);

  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Settings')");
  await page.waitForSelector("text=Reader plugins");
  await page.waitForSelector("li:text-is('Text lines (example) 1.0.0 (.lines) · API 1')");
  await page.waitForSelector("text=This program gives plugins version 2 of the plugin contract");
  await page.waitForSelector("text=from-the-future: it is written for plugin API 3"); // a plugin for a newer contract is skipped, with the reason
  expect(errors).toEqual([]);
  await ctx.close();
});
