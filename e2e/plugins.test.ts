import { expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { after, api, before, bookId, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;

const NOTES = Array.from({ length: 200 }, (_, i) => `row ${i + 1} of the notes`).join("\n");

before(async () => {
  browser = await launch();
  // the example plugin that comes with the repository reads ".lines" files, which the program itself knows nothing about
  inst = await startServer({ "Notes.lines": NOTES, "Plain.txt": "an ordinary text book, read by the built-in reader" }, { TAPALOG_PLUGINS: join(import.meta.dir, "..", "plugins-example") });
  await setup(inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
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
  expect(await page.locator(".thumb img").count()).toBe(1); // the text book has none: a tile with its format

  // a built-in format is still read by the built-in reader
  await page.goto(`${inst.url}/#book=${await bookId(ctx, inst, "Plain.txt")}`);
  await page.waitForSelector(".txt-body");
  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("the administrator can see which plugins are installed", async () => {
  const ctx = await signedIn(browser, inst);
  const listed = await api<{ plugins: { id: string; exts: string[] }[]; problems: unknown[] }>(ctx, inst, "/api/admin/plugins");
  expect(listed.plugins.map((p) => [p.id, p.exts])).toEqual([["text-lines", ["lines"]]]);
  expect(listed.problems).toEqual([]);

  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Settings')");
  await page.waitForSelector("text=Reader plugins");
  await page.waitForSelector("li:text-is('Text lines (example) 1.0.0 (.lines)')");
  expect(errors).toEqual([]);
  await ctx.close();
});
