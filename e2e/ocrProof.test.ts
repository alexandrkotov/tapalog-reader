import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

const PAGES = 12;

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/proof.pdf": scanPdf(Array.from({ length: PAGES }, () => picture!), PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, { width: 1200, height: 700 });
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  // what the browser would have handed over: pages 1, 3 and 12 read, page 3 corrected by hand since
  const id = await bookId(ctx, inst, "Scans/proof.pdf");
  await api(ctx, inst, `/api/admin/ocr/${id}/start`, { pages: PAGES, lang: "rus" });
  const send = (path: string, text: string) => ctx.request.put(`${inst.url}/api/admin/ocr/${id}/${path}`, { data: { text }, headers: { Origin: inst.url } });
  await send("pages/1", "Ламповый радиоприёмник для начинающих радиолюбителей");
  await send("pages/3", "С ошибкой в слове осцилограф");
  await send("pages/12", "Последняя страница книги");
  await send("edit/3", "Исправлено: осциллограф");
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("the window for checking shows each scanned page beside its text, draws only the pages near the window, and lets the far ones go", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForSelector(".ocr-row");
  await page.click(".ocr-row .ocr-proof");

  await page.waitForFunction((n) => document.querySelectorAll(".proof-row").length === n, PAGES);
  expect(await page.textContent(".proof-stats")).toBe(`Recognized pages: 3 of ${PAGES}`);
  expect(await page.$$eval(".proof-label", (n) => n.slice(0, 3).map((x) => x.textContent))).toEqual(["Page 1", "Page 2", "Page 3"]);
  // the text of a page that was read, the empty one that was not, and a corrected one with its mark
  const texts = await page.$$eval(".proof-text", (n) => n.map((x) => (x as HTMLTextAreaElement).value));
  expect(texts[0]).toBe("Ламповый радиоприёмник для начинающих радиолюбителей");
  expect(texts[1]).toBe("");
  expect(await page.getAttribute(".proof-row:nth-child(2) .proof-text", "placeholder")).toBe("This page has not been recognized yet.");
  expect(texts[2]).toBe("Исправлено: осциллограф");
  expect(await page.$$eval(".proof-badge", (n) => n.map((x) => x.textContent))).toEqual(["corrected"]);
  expect(texts[11]).toBe("Последняя страница книги");

  // the first page is drawn, and the picture really has the page's writing on it
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
  const dark = await page.$eval(".proof-row:nth-child(1) .proof-canvas", (c) => {
    const canvas = c as HTMLCanvasElement;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4 * 17) if (data[i]! < 100) n++;
    return n;
  });
  expect(dark).toBeGreaterThan(50);
  // a scan and its text stand side by side and are as tall as each other
  const sizes = await page.$eval(".proof-row:nth-child(1)", (row) => {
    const scan = row.querySelector(".proof-scan")!.getBoundingClientRect();
    const text = row.querySelector(".proof-text")!.getBoundingClientRect();
    return { sameTop: Math.abs(scan.top - row.getBoundingClientRect().top) < 2, leftOf: scan.right <= text.left, textFits: text.bottom <= scan.bottom + 1 };
  });
  expect(sizes).toEqual({ sameTop: true, leftOf: true, textFits: true });

  // not every page is drawn: only those near the window
  const drawn = () => page.$$eval(".proof-canvas", (n) => n.length);
  expect(await drawn()).toBeLessThan(PAGES);
  // at the end of the book the last page is drawn and the first is let go
  await page.$eval(".proof-pages", (s) => (s.scrollTop = s.scrollHeight));
  await page.waitForSelector(`.proof-row:nth-child(${PAGES}) .proof-canvas`);
  await page.waitForFunction(() => !document.querySelector(".proof-row:nth-child(1) .proof-canvas"));
  expect(await drawn()).toBeLessThan(PAGES);
  // and coming back draws it again
  await page.$eval(".proof-pages", (s) => (s.scrollTop = 0));
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");

  await page.click(".proof .modal-head .icon-btn");
  await page.waitForFunction(() => !document.querySelector(".proof"));
  expect(errors).toEqual([]);
  await page.close();
});
