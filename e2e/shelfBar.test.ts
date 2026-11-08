import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { epub } from "./fixtures";
import { ADMIN, after, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
const ids: Record<string, string> = {};

before(async () => {
  browser = await launch();
  inst = await startServer({ "Lib/alpha.txt": "alpha", "Lib/beta.txt": "beta", "Lib/nodate.txt": "no year", "Lib/Sub/gamma.epub": epub("Gamma") });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  for (const [name, path] of [["alpha", "Lib/alpha.txt"], ["beta", "Lib/beta.txt"], ["gamma", "Lib/Sub/gamma.epub"]] as const) ids[name] = await bookId(ctx, inst, path);
  const set = (name: string, fields: Record<string, unknown>) => ctx.request.put(`${inst.url}/api/admin/books/${ids[name]}/meta`, { data: { set: fields }, headers: { Origin: inst.url } });
  await set("alpha", { title: "alpha", authors: ["Zorin"], year: 1950, tags: ["радио"] });
  await set("beta", { title: "beta", authors: ["Abel"], year: 1930 });
  await set("gamma", { title: "gamma", authors: ["Zorin B."], year: 1990, tags: ["радио"] });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

/** The titles on the shelf in the order shown (the first text of a name: a list line may add the folder after it). */
const names = (page: Page) => page.$$eval(".shelf .card .name", (spans) => spans.map((s) => s.childNodes[0]!.textContent));

e2e("the shelf can be a list, ordered by title, author, year or last opened, and the choice is kept", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#folder=Lib`);
  await page.waitForSelector(".shelf-bar");
  expect(await names(page)).toEqual(["Sub", "alpha", "beta", "nodate"]); // the folder first, the books by title

  await page.selectOption(".bar-sort", "year"); // a book without a year is last
  expect(await names(page)).toEqual(["Sub", "beta", "alpha", "nodate"]);
  await page.click(".bar-direction");
  expect(await names(page)).toEqual(["Sub", "alpha", "beta", "nodate"]); // reversed, and still last
  await page.selectOption(".bar-sort", "author");
  expect(await names(page)).toEqual(["Sub", "beta", "alpha", "nodate"]); // Abel, Zorin

  // as a list: a line per book with its year, and the ⓘ still opens the details
  await page.click(".bar-view[data-view=list]");
  await page.waitForSelector(".shelf.list");
  expect(await page.$$eval(".shelf.list .card.row .year", (n) => n.map((x) => x.textContent))).toEqual(["1930", "1950", ""]); // the folder's line has no year
  await page.click(".card.row:has-text('beta') .card-info");
  await page.waitForSelector(".card-form");
  await page.keyboard.press("Escape");

  // the layout and the order are kept for the next visit
  await page.reload();
  await page.waitForSelector(".shelf.list");
  expect(await page.inputValue(".bar-sort")).toBe("author");
  expect(await names(page)).toEqual(["Sub", "beta", "alpha", "nodate"]);

  // last opened: a book this reader opened comes first among the books, and the others keep their title order
  expect((await ctx.request.put(`${inst.url}/api/progress/${ids.alpha}`, { data: {}, headers: { Origin: inst.url } })).status()).toBe(200);
  await page.reload();
  await page.waitForSelector(".shelf-bar");
  await page.selectOption(".bar-sort", "opened");
  await page.waitForFunction(() => document.querySelector(".shelf .card:nth-child(2) .name")?.childNodes[0]?.textContent === "alpha");
  expect(await names(page)).toEqual(["Sub", "alpha", "beta", "nodate"]);

  await page.click(".bar-view[data-view=grid]");
  await page.waitForSelector(".shelf:not(.list)");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("filters by format, tag and author look in this folder and the folders below it, and are forgotten on another shelf", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#folder=Lib`);
  await page.waitForSelector(".shelf-bar");
  await page.selectOption(".bar-sort", "title");
  await page.waitForSelector(".bar-reset", { state: "hidden" });
  expect(await page.$$eval(".bar-format option", (o) => o.map((x) => x.textContent))).toEqual(["Any", "TXT (3)", "EPUB (1)"]);

  await page.selectOption(".bar-format", "epub"); // gamma lies in Sub: the filter reaches it and the folders give way
  expect(await names(page)).toEqual(["gamma"]);
  expect(await page.textContent(".bar-status")).toBe("Shown 1 of 4 books in this folder and the folders in it");

  await page.selectOption(".bar-format", "");
  await page.fill(".bar-author", "zorin"); // part of a name, whatever the letter case
  await page.waitForFunction(() => document.querySelector(".bar-status")?.textContent?.startsWith("Shown 2"));
  expect(await names(page)).toEqual(["alpha", "gamma"]);
  await page.selectOption(".bar-tag", "радио");
  await page.selectOption(".bar-format", "txt"); // all three at once
  await page.waitForFunction(() => document.querySelector(".bar-status")?.textContent?.startsWith("Shown 1 "));
  expect(await names(page)).toEqual(["alpha"]);
  await page.selectOption(".bar-format", "epub");
  await page.fill(".bar-author", "abel"); // nothing has all of that
  await page.waitForSelector(".shelf-empty");
  expect(await page.textContent(".shelf-empty")).toBe("No book matches these filters.");

  await page.click(".bar-reset");
  await page.waitForSelector(".bar-reset", { state: "hidden" });
  expect(await names(page)).toEqual(["Sub", "alpha", "beta", "nodate"]);
  expect(await page.inputValue(".bar-author")).toBe("");

  // another shelf starts without filters
  await page.selectOption(".bar-format", "txt");
  await page.evaluate(() => (location.hash = "#folder=Lib%2FSub"));
  await page.waitForSelector(".card:has-text('gamma')");
  await page.goBack();
  await page.waitForSelector(".shelf-bar");
  expect(await page.inputValue(".bar-format")).toBe("");
  expect(await names(page)).toEqual(["Sub", "alpha", "beta", "nodate"]);

  // the books of a tag can be narrowed the same way
  await page.goto(`${inst.url}/#tags=${encodeURIComponent("радио")}`);
  await page.reload();
  await page.waitForSelector(".tag-found");
  expect(await names(page)).toEqual(["alpha", "gamma"]);
  await page.selectOption(".bar-format", "epub");
  expect(await names(page)).toEqual(["gamma"]);
  expect(await page.textContent(".tag-found")).toBe("Books with all of these tags: 2");
  expect(errors).toEqual([]);
  await page.close();
});
