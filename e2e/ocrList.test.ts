import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  const pages = (n: number) => scanPdf(Array.from({ length: n }, () => picture!), PAGE_W, PAGE_H); // more pages, a bigger file
  inst = await startServer({ "Alpha/one.pdf": pages(1), "Alpha/two.pdf": pages(3), "Beta/three.pdf": pages(2), "Beta/four.pdf": pages(4) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  for (let i = 0; i < 120; i++) {
    if ((await api<{ books: unknown[] }>(ctx, inst, "/api/admin/ocr")).books.length === 4) break;
    await Bun.sleep(250);
  }
  // "three" is recognized to the end and "two" half way, without running the engine: the pages are handed to the server as the browser would
  const put = (id: string, page: number) => ctx.request.put(`${inst.url}/api/admin/ocr/${id}/pages/${page}`, { data: { text: `text ${page}` }, headers: { Origin: inst.url } });
  const three = await bookId(ctx, inst, "Beta/three.pdf");
  await api(ctx, inst, `/api/admin/ocr/${three}/start`, { pages: 2, lang: "rus" });
  await put(three, 1);
  await put(three, 2);
  const two = await bookId(ctx, inst, "Alpha/two.pdf");
  await api(ctx, inst, `/api/admin/ocr/${two}/start`, { pages: 3, lang: "rus" });
  await put(two, 1);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const titles = (page: Page) => page.$$eval(".ocr-title", (n) => n.map((x) => x.textContent));
const counter = (page: Page) => page.textContent(".ocr-count");

async function openWindow(): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForFunction(() => document.querySelectorAll(".ocr-row").length === 4);
  return page;
}

e2e("the list of scans can be searched, filtered by state and ordered, and 'Select the unrecognized' ticks only the books on view", async () => {
  const page = await openWindow();
  // by folder and name to begin with
  expect(await titles(page)).toEqual(["one", "two", "four", "three"]); // Alpha/one, Alpha/two, Beta/four, Beta/three
  expect(await counter(page)).toBe("Shown 4 of 4 · ticked 0");

  // a search by a folder, and by two words in any order
  await page.fill(".ocr-query", "alpha");
  expect(await titles(page)).toEqual(["one", "two"]);
  expect(await counter(page)).toBe("Shown 2 of 4 · ticked 0");
  await page.fill(".ocr-query", "PDF TWO");
  expect(await titles(page)).toEqual(["two"]);
  await page.fill(".ocr-query", "nothing like it");
  expect(await titles(page)).toEqual([]);
  expect(await page.textContent(".ocr-list")).toBe("No scanned PDF matches.");
  await page.fill(".ocr-query", "");

  // by state
  await page.selectOption(".ocr-show", "unread");
  expect(await titles(page)).toEqual(["one", "two", "four"]); // all but the one recognized to the end
  await page.selectOption(".ocr-show", "partial");
  expect(await titles(page)).toEqual(["two"]);
  await page.selectOption(".ocr-show", "done");
  expect(await titles(page)).toEqual(["three"]);
  await page.selectOption(".ocr-show", "all");

  // the order: the unrecognized first, the biggest first, by title
  await page.selectOption(".ocr-sort", "unread");
  expect(await titles(page)).toEqual(["one", "four", "two", "three"]); // new ones, the half done, the done
  await page.selectOption(".ocr-sort", "size");
  expect(await titles(page)).toEqual(["four", "two", "three", "one"]);
  await page.selectOption(".ocr-sort", "title");
  expect(await titles(page)).toEqual(["four", "one", "three", "two"]);

  // "Select the unrecognized" ticks what is on view only, and the counter says how many are ticked
  await page.selectOption(".ocr-sort", "path");
  await page.fill(".ocr-query", "alpha");
  await page.click(".ocr-actions .btn:has-text('Select the unrecognized')");
  expect(await counter(page)).toBe("Shown 2 of 4 · ticked 2");
  await page.fill(".ocr-query", "");
  expect(await page.$$eval(".ocr-row", (rows) => rows.map((r) => (r.querySelector("input") as HTMLInputElement).checked))).toEqual([true, true, false, false]);
  await page.click(`.ocr-row:has(.ocr-title:text-is('four')) input`);
  expect(await counter(page)).toBe("Shown 4 of 4 · ticked 3");
  await page.close();
});

e2e("the chosen order is remembered the next time the window is opened", async () => {
  const page = await openWindow();
  await page.selectOption(".ocr-sort", "size");
  await page.keyboard.press("Escape"); // the window
  await page.keyboard.press("Escape"); // Settings
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForFunction(() => document.querySelectorAll(".ocr-row").length === 4);
  expect(await page.inputValue(".ocr-sort")).toBe("size");
  expect(await titles(page)).toEqual(["four", "two", "three", "one"]);
  expect(await page.inputValue(".ocr-query")).toBe(""); // the words typed and the state shown are not kept
  expect(await page.inputValue(".ocr-show")).toBe("all");
  await page.close();
});
