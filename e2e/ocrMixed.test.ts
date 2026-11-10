import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { mixedPdf, PAGE_H, PAGE_W, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  // two typeset pages, then a scanned one
  const book = mixedPdf([{ lines: ["Typeset preface of the handbook", "written for beginners of the workshop"] }, { lines: ["Chapter one explains how a transformer works", "and why the windings are wound in layers"] }, { picture: picture! }], PAGE_W, PAGE_H);
  inst = await startServer({ "Mixed/handbook.pdf": book });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("in a book of mixed pages the pages that have text of their own are taken as they are, and only the picture is read", async () => {
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  for (let i = 0; ; i++) {
    if ((await api<{ books: unknown[] }>(ctx, inst, "/api/admin/ocr")).books.length === 1) break;
    if (i > 120) throw new Error("the book was never offered");
    await Bun.sleep(250);
  }
  const id = await bookId(ctx, inst, "Mixed/handbook.pdf");
  const search = async (q: string) => (await api<{ books: { hits: { loc: { page: number } }[] }[] }>(ctx, inst, "/api/fulltext?q=" + encodeURIComponent(q))).books;
  for (let i = 0; (await search("transformer")).length === 0; i++) {
    if (i > 120) throw new Error("the text of the typeset pages was never indexed");
    await Bun.sleep(250);
  }

  const page = await ctx.newPage();
  const errors = watchErrors(page, /Estimating resolution|Detected \d+ diacritics/);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForFunction(() => document.querySelectorAll(".ocr-row").length === 1);
  await page.selectOption(".ocr-lang", "rus+eng");
  expect(await page.isChecked(".ocr-own")).toBe(true); // on until it is turned off
  await page.check(".ocr-row input");
  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Done"), undefined, { timeout: 110_000 });
  expect(await page.textContent(".ocr-message")).toBe("Done: 1 pages recognized. 2 pages with their own text were taken as they are.");
  expect(await page.textContent(".ocr-status")).toBe("Recognized, 3 pages · 2 pages with the text of the PDF");

  // the words with frames exist only where a picture was read
  expect((await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes/3`)).status()).toBe(200);
  expect((await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes/1`)).status()).toBe(404);
  expect((await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes/2`)).status()).toBe(404);

  // the book for checking and export has every page, the two typeset ones marked as the PDF's own
  const book = await api<{ done: number; pages: number; items: { page: number; text: string; own?: true }[] }>(ctx, inst, `/api/admin/ocr/${id}/pages`);
  expect(book).toMatchObject({ done: 3, pages: 3 });
  expect(book.items.map((p) => p.page)).toEqual([1, 2, 3]);
  expect(book.items.map((p) => !!p.own)).toEqual([true, true, false]);
  expect(book.items[0]!.text).toBe("Typeset preface of the handbook written for beginners of the workshop");
  expect(book.items[2]!.text.toLowerCase().replace(/ё/g, "е")).toContain("радиоприемник");
  const exported = await (await ctx.request.get(`${inst.url}/api/admin/ocr/${id}/text?format=txt`)).text();
  expect(exported).toContain("Chapter one explains how a transformer works");
  expect(exported.toLowerCase().replace(/ё/g, "е")).toContain("радиоприемник");

  // search finds the typeset words once (from the index of the file) and the picture's words once (from the reading)
  const own = await search("transformer");
  expect(own).toHaveLength(1);
  expect(own[0]!.hits.map((h) => h.loc.page)).toEqual([2]);
  const read = await search("радиоприёмник");
  expect(read).toHaveLength(1);
  expect(read[0]!.hits.map((h) => h.loc.page)).toEqual([3]);

  expect(errors).toEqual([]);
  await page.close();
});

e2e("with the checkbox turned off the typeset pages are read from their pictures like the rest, and the choice is remembered", async () => {
  const id = await bookId(ctx, inst, "Mixed/handbook.pdf");
  // what the first test kept is forgotten, so that the whole book is read again
  await ctx.request.delete(`${inst.url}/api/admin/ocr/${id}`, { headers: { Origin: inst.url } });
  const page = await ctx.newPage();
  const errors = watchErrors(page, /Estimating resolution|Detected \d+ diacritics/);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForFunction(() => document.querySelectorAll(".ocr-row").length === 1);
  await page.selectOption(".ocr-lang", "rus+eng");
  await page.uncheck(".ocr-own");
  await page.check(".ocr-row input");
  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Done"), undefined, { timeout: 110_000 });
  expect(await page.textContent(".ocr-message")).toBe("Done: 3 pages recognized.");
  const book = await api<{ items: { page: number; text: string; own?: true }[] }>(ctx, inst, `/api/admin/ocr/${id}/pages`);
  expect(book.items.some((p) => p.own)).toBe(false);
  expect(book.items[0]!.text.toLowerCase()).toContain("preface");
  expect((await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes/1`)).status()).toBe(200); // read from the picture: its words have frames
  await page.close();

  // the next time the window opens the box is still off
  const again = await ctx.newPage();
  await again.goto(inst.url + "/");
  await again.waitForSelector(".credit-about", { state: "attached" });
  await again.click("button:has-text('Settings')");
  await again.waitForSelector(".modal .section");
  await again.click("button:has-text('Recognize scanned pages')");
  await again.waitForSelector(".ocr-own");
  expect(await again.isChecked(".ocr-own")).toBe(false);
  expect(errors).toEqual([]);
  await again.close();
});
