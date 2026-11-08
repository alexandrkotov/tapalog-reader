import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
const ids: Record<string, string> = {};

before(async () => {
  browser = await launch();
  inst = await startServer({ "Books/a.txt": "book a", "Books/b.txt": "book b", "Docs/c.txt": "book c", "d.txt": "book d" });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  for (const [name, path] of [["a", "Books/a.txt"], ["b", "Books/b.txt"], ["c", "Docs/c.txt"], ["d", "d.txt"]] as const) ids[name] = await bookId(ctx, inst, path);
  const tag = (name: string, tags: string[]) => ctx.request.put(`${inst.url}/api/admin/books/${ids[name]}/meta`, { data: { set: { tags } }, headers: { Origin: inst.url } });
  await tag("a", ["Радио", "схемы"]);
  await tag("b", ["радио"]); // the same tag, written in another letter case
  await tag("c", ["Радио", "лампы"]);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const chips = (page: Page) => page.$$eval(".tag-bar .tag-chip", (nodes) => nodes.map((n) => `${n.querySelector("span")!.textContent}:${n.querySelector(".tag-count")!.textContent}${n.classList.contains("on") ? "*" : ""}`));
const shown = (page: Page) => page.$$eval(".shelf .card .name", (spans) => spans.map((s) => s.textContent!).sort());

e2e("the tags in use are buttons above the shelf; choosing them keeps the books that have all of them, wherever they lie", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".tag-bar");
  // one tag whatever the letter case, most books first, written the way most books write it
  expect(await chips(page)).toEqual(["Радио:3", "лампы:1", "схемы:1"]);

  await page.click(".tag-chip:has-text('Радио')");
  await page.waitForSelector(".tag-found");
  expect(await page.evaluate(() => decodeURIComponent(location.hash))).toBe("#tags=радио");
  expect(await page.textContent(".tag-found")).toBe("Books with all of these tags: 3");
  expect(await shown(page)).toEqual(["a", "b", "c"]); // from two folders
  expect(await chips(page)).toEqual(["Радио:3*", "лампы:1", "схемы:1"]);

  await page.click(".tag-chip:has-text('схемы')"); // narrows: all of the tags
  await page.waitForFunction(() => document.querySelector(".tag-found")?.textContent?.endsWith(": 1"));
  expect(await shown(page)).toEqual(["a"]);
  expect(await chips(page)).toEqual(["Радио:3*", "лампы:1", "схемы:1*"]);

  await page.reload(); // the address holds the choice
  await page.waitForSelector(".tag-found");
  expect(await shown(page)).toEqual(["a"]);

  await page.click(".tag-chip:has-text('лампы')"); // no book has all three
  await page.waitForFunction(() => document.querySelector(".tag-found")?.textContent === "No book has all of these tags.");
  expect(await page.$(".shelf .card")).toBeNull();
  await page.click(".tag-chip:has-text('схемы')"); // taken out again
  await page.click(".tag-chip:has-text('Радио')");
  await page.waitForFunction(() => document.querySelector(".tag-found")?.textContent?.endsWith(": 1"));
  expect(await shown(page)).toEqual(["c"]); // лампы alone

  await page.click(".tag-clear");
  await page.waitForSelector(".recent, .shelf .card");
  expect(await page.evaluate(() => location.hash)).toBe("");
  expect(await page.$(".tag-found")).toBeNull();
  expect(await chips(page)).toEqual(["Радио:3", "лампы:1", "схемы:1"]);
  expect(await page.$$eval(".shelf .card .name", (spans) => spans.map((s) => s.textContent))).toContain("Books"); // the top shelf again
  expect(errors).toEqual([]);
  await page.close();
});

e2e("in a book's window the administrator picks tags already in use, and a reader's tags lead to the books that have them", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".tag-bar");
  await page.click(".card:has-text('d') .card-info"); // d.txt has no tag yet
  await page.waitForSelector(".card-form");
  expect(await page.$$eval(".card-pick", (n) => n.map((x) => x.textContent))).toEqual(["+ Радио", "+ лампы", "+ схемы"]);
  await page.click(".card-pick:has-text('Радио')");
  await page.click(".card-pick:has-text('лампы')");
  expect(await page.inputValue(".card-form .card-field:nth-child(6) input")).toBe("Радио, лампы");
  expect(await page.$$eval(".card-pick", (n) => n.map((x) => x.textContent))).toEqual(["+ схемы"]); // what is typed is not offered again
  await page.click(".card-form button[type=submit]");
  await page.waitForSelector(".card-saved:not([hidden])");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".tag-chip span")?.nextElementSibling?.textContent === "4"); // the bar counts d now
  expect(await chips(page)).toEqual(["Радио:4", "лампы:2", "схемы:1"]);

  // a reader sees the tags as links
  await api(ctx, inst, "/api/admin/users", { name: "Reader", password: "pin123", role: "user" });
  const readerCtx = await signedIn(browser, inst, { name: "Reader", password: "pin123" });
  const reader = await readerCtx.newPage();
  const readerErrors = watchErrors(reader);
  await reader.goto(inst.url + "/");
  await reader.waitForSelector(".tag-bar");
  expect(await chips(reader)).toEqual(["Радио:4", "лампы:2", "схемы:1"]);
  await reader.click(".card.folder:has-text('Books')"); // a.txt lies in a folder
  await reader.waitForSelector(".card:has-text('a') .card-info");
  await reader.click(".card:has-text('a') .card-info");
  await reader.waitForSelector(".card-read");
  await reader.click(".card-tag:has-text('схемы')");
  expect(await reader.$(".modal")).toBeNull(); // the window closed
  await reader.waitForSelector(".tag-found");
  expect(await reader.evaluate(() => decodeURIComponent(location.hash))).toBe("#tags=схемы");
  expect(await shown(reader)).toEqual(["a"]);
  expect(errors).toEqual([]);
  expect(readerErrors).toEqual([]);
  await readerCtx.close();
  await page.close();
});
