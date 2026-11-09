import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let id = "";

const BOXES = [
  ["Лампа", 0.1, 0.2, 0.3, 0.25],
  ["схема", 0.32, 0.2, 0.5, 0.25],
  ["вторая", 0.1, 0.3, 0.3, 0.35],
  ["строка", 0.32, 0.3, 0.5, 0.35],
];

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/scan.pdf": scanPdf([picture!, picture!], PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  id = await bookId(ctx, inst, "Scans/scan.pdf");
  // a book read by the recognizer: page 1 with the frames of its words, page 2 read without
  const send = (path: string, method: string, body: unknown) => ctx.request.fetch(`${inst.url}/api/admin/ocr/${id}${path}`, { method, data: body, headers: { Origin: inst.url } });
  await send("/start", "POST", { pages: 2, lang: "rus" });
  await send("/pages/1", "PUT", { text: "Лампа схема\nвторая строка", boxes: BOXES });
  await send("/pages/2", "PUT", { text: "Вторая страница" });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#book=${id}`);
  await page.waitForSelector(".pdf-scroll .page canvas");
  return { page, errors };
}

/** Where a word is on page 1, as parts of the page's box, once the page has stopped moving. */
async function placed(page: Page, word: string): Promise<{ x: number; y: number; w: number; h: number }> {
  let last = "";
  for (let i = 0; i < 100; i++) {
    const found = await page.evaluate((word) => {
      const el = document.querySelector<HTMLElement>('.pdf-scroll .page[data-page-number="1"]')!;
      const outer = el.getBoundingClientRect();
      const pageBox = { left: outer.left + el.clientLeft, top: outer.top + el.clientTop, width: el.clientWidth, height: el.clientHeight }; // the page's own box: the viewer gives it a transparent border
      const span = [...document.querySelectorAll<HTMLElement>('.pdf-scroll .page[data-page-number="1"] .ocr-word')].find((s) => s.textContent === word);
      if (!span) return null;
      const r = span.getBoundingClientRect();
      return { x: (r.left - pageBox.left) / pageBox.width, y: (r.top - pageBox.top) / pageBox.height, w: r.width / pageBox.width, h: r.height / pageBox.height };
    }, word);
    const key = JSON.stringify(found);
    if (found && key === last) return found;
    last = key;
    await Bun.sleep(100);
  }
  throw new Error(`the word ${word} never settled`);
}

const near = (got: { x: number; y: number; w: number; h: number }, want: [number, number, number, number]) => {
  expect(got.x).toBeCloseTo(want[0], 2);
  expect(got.y).toBeCloseTo(want[1], 2);
  expect(got.w).toBeCloseTo(want[2], 2);
  expect(got.h).toBeCloseTo(want[3], 2);
};

e2e("the words of a recognized scan lie over the picture where they were found, can be selected and copied, and follow the page when it is turned", async () => {
  const { page, errors } = await open();
  await page.waitForFunction(() => document.querySelectorAll('.pdf-scroll .page[data-page-number="1"] .ocr-word').length === 4);

  // each word is as big as its frame on the page
  near(await placed(page, "Лампа"), [0.1, 0.2, 0.2, 0.05]);
  near(await placed(page, "схема"), [0.32, 0.2, 0.18, 0.05]);
  near(await placed(page, "строка"), [0.32, 0.3, 0.18, 0.05]);

  // a double click on a word selects that word, whatever the picture under it
  const spot = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.pdf-scroll .page[data-page-number="1"]')!;
    const box = el.getBoundingClientRect();
    return { x: box.left + el.clientLeft + el.clientWidth * 0.41, y: box.top + el.clientTop + el.clientHeight * 0.225 };
  });
  await page.mouse.dblclick(spot.x, spot.y);
  expect((await page.evaluate(() => getSelection()!.toString())).trim()).toBe("схема");

  // the whole page copies as lines of words
  const copied = await page.evaluate(() => {
    const frame = document.querySelector('.pdf-scroll .page[data-page-number="1"] .ocr-frame')!;
    const range = document.createRange();
    range.selectNodeContents(frame);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    return getSelection()!.toString();
  });
  expect(copied.trim()).toBe("Лампа схема\nвторая строка");

  // turned a quarter clockwise, a point (x, y) of the page goes to (1 - y, x): the words stay on the letters they were found on
  await page.click(".pdf-toolbar button[aria-label='Rotate']");
  await page.waitForFunction(() => {
    const r = document.querySelector<HTMLElement>(".pdf-scroll .page")!.getBoundingClientRect();
    return r.width > r.height; // on its side
  });
  near(await placed(page, "Лампа"), [0.75, 0.1, 0.05, 0.2]);
  near(await placed(page, "строка"), [0.65, 0.32, 0.05, 0.18]);
  await page.click(".pdf-toolbar button[aria-label='Rotate']");
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.pdf-scroll .page[data-page-number="1"] .ocr-frame')?.dataset.turn === "180");
  near(await placed(page, "Лампа"), [0.7, 0.75, 0.2, 0.05]); // (x, y) goes to (1 - x, 1 - y)
  await page.click(".pdf-toolbar button[aria-label='Rotate']");
  await page.click(".pdf-toolbar button[aria-label='Rotate']"); // four turns bring the page back
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.pdf-scroll .page[data-page-number="1"] .ocr-frame')?.dataset.turn === "0");
  near(await placed(page, "Лампа"), [0.1, 0.2, 0.2, 0.05]);
  expect(errors).toEqual([]);
  await ctx.request.put(`${inst.url}/api/display/${id}`, { data: { display: {} }, headers: { Origin: inst.url } }); // the turn is kept for the book: not for the next test
  await page.close();
});

e2e("a page the recognizer read without frames, and a page written by hand, have no words over them", async () => {
  const send = (path: string, method: string, body?: unknown) => ctx.request.fetch(`${inst.url}/api/admin/ocr/${id}${path}`, { method, data: body, headers: { Origin: inst.url } });
  await send("/edit/1", "PUT", { text: "Лампа, схема" });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  const listed = page.waitForResponse((res) => res.url().endsWith(`/api/ocr/${id}/boxes`));
  await page.goto(`${inst.url}/#book=${id}`);
  await page.waitForSelector(".pdf-scroll .page canvas");
  expect(await (await listed).json()).toEqual({ pages: [] }); // page 1 is written by hand, page 2 was read without frames
  await page.waitForTimeout(500);
  expect(await page.$$eval(".ocr-word", (n) => n.length)).toBe(0);

  await send("/edit/1", "DELETE"); // taken back, the words are there again
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".ocr-word").length === 4);
  expect(errors).toEqual([]);
  await page.close();
});
