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
  await page.waitForFunction(() => !document.querySelector(".tag-found")); // the tag view is gone (a list of selectors would pick the hidden, empty "Continue reading" block)
  await page.waitForSelector(".shelf .card");
  expect(await page.evaluate(() => location.hash)).toBe("");
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

e2e("the administrator renames, merges and removes tags for all books from one window, and a reader has no such button", async () => {
  // a library of its own tags: the tests above leave theirs on the books
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  page.on("dialog", (dialog) => void dialog.accept()); // the question before a merge and a removal
  const set = (name: string, tags: string[]) => ctx.request.put(`${inst.url}/api/admin/books/${ids[name]}/meta`, { data: { set: { tags } }, headers: { Origin: inst.url } });
  await set("a", ["Радио", "схемы"]);
  await set("b", ["радио"]);
  await set("c", ["Радио", "лампы"]);
  await set("d", ["лампы"]);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".tag-bar");
  expect(await chips(page)).toEqual(["Радио:3", "лампы:2", "схемы:1"]);

  await page.click(".tag-manage");
  await page.waitForSelector(".tag-manage-row");
  expect(await page.$$eval(".tag-manage-row .tag-manage-name", (n) => n.map((x) => x.textContent))).toEqual(["Радио", "лампы", "схемы"]);

  // renamed: every book follows, the bar behind the window too
  await page.click(".tag-manage-row:has-text('схемы') .tag-rename");
  await page.fill(".tag-manage-input", "чертежи");
  await page.click(".tag-manage-row .btn.primary");
  await page.waitForFunction(() => document.querySelector(".tag-manage-status")?.textContent === "Changed in 1 books.");
  await page.waitForFunction(() => [...document.querySelectorAll(".tag-bar .tag-chip")].some((c) => c.querySelector("span")?.textContent === "чертежи"));
  expect(await chips(page)).toEqual(["Радио:3", "лампы:2", "чертежи:1"]);

  // merged into a tag in use (a question is asked and answered yes): the books with both keep one
  await page.click(".tag-manage-row:has-text('чертежи') .tag-rename");
  await page.fill(".tag-manage-input", "РАДИО");
  await page.click(".tag-manage-row .btn.primary");
  await page.waitForFunction(() => [...document.querySelectorAll(".tag-bar .tag-chip")].every((c) => c.querySelector("span")?.textContent !== "чертежи"));
  expect(await chips(page)).toEqual(["Радио:3", "лампы:2"]);
  const tagsOfA = await ctx.request.get(`${inst.url}/api/books/${ids.a}/meta`).then((r) => r.json());
  expect(tagsOfA.fields.tags).toEqual(["Радио"]); // had both: one is left

  // removed from all books
  await page.click(".tag-manage-row:has-text('лампы') .tag-remove");
  await page.waitForFunction(() => document.querySelectorAll(".tag-manage-row").length === 1);
  expect(await chips(page)).toEqual(["Радио:3"]);
  await page.click(".tag-manage-row:has-text('Радио') .tag-rename");
  await page.fill(".tag-manage-input", "  ");
  await page.click(".tag-manage-row .btn.primary");
  await page.waitForSelector(".modal .project-missing:not([hidden])");
  expect(await page.textContent(".modal .project-missing")).toContain("cannot be used");
  await page.keyboard.press("Escape"); // leaves the edit
  await page.keyboard.press("Escape"); // and then the window
  expect(await page.$(".modal")).toBeNull();

  // a reader has no button
  await api(ctx, inst, "/api/admin/users", { name: "Plain", password: "pin123", role: "user" }).catch(() => undefined);
  const readerCtx = await signedIn(browser, inst, { name: "Plain", password: "pin123" });
  const reader = await readerCtx.newPage();
  await reader.goto(inst.url + "/");
  await reader.waitForSelector(".tag-bar");
  expect(await reader.$(".tag-manage")).toBeNull();
  expect(errors).toEqual([]);
  await readerCtx.close();
  await page.close();
});
