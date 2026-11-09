import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

const PAGES = 12;

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let id = "";

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/proof.pdf": scanPdf(Array.from({ length: PAGES }, () => picture!), PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, { width: 1200, height: 700 });
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  // what the browser would have handed over: pages 1, 3 and 12 read, page 3 corrected by hand since
  id = await bookId(ctx, inst, "Scans/proof.pdf");
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
  expect(await page.$$eval(".proof-label", (n) => n.slice(0, 3).map((x) => x.textContent))).toEqual(["Page 1", "Page 2", "Page 3"]);
  // the text of a page that was read, the empty one that was not, and a corrected one with its mark
  const texts = await page.$$eval(".proof-text", (n) => n.map((x) => (x as HTMLTextAreaElement).value));
  expect(texts[0]).toBe("Ламповый радиоприёмник для начинающих радиолюбителей");
  expect(texts[1]).toBe("");
  expect(await page.getAttribute(".proof-row:nth-child(2) .proof-text", "placeholder")).toBe("This page has not been recognized yet.");
  expect(texts[2]).toBe("Исправлено: осциллограф");
  expect(await page.$$eval(".proof-badge:not([hidden])", (n) => n.map((x) => x.textContent))).toEqual(["corrected"]);
  expect(await page.textContent(".proof-stats")).toBe(`Recognized pages: 3 of ${PAGES} · corrected: 1`);
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

// ----- correcting the text on the spot -----

interface Held {
  pages: number;
  done: number;
  edited: number;
  items: { page: number; text: string; edited: boolean }[];
}
const held = () => api<Held>(ctx, inst, `/api/admin/ocr/${id}/pages`);
const found = async (word: string) => (await api<{ books: { id: string }[] }>(ctx, inst, "/api/fulltext?q=" + encodeURIComponent(word))).books.map((b) => b.id);

/** Polls until what the server holds satisfies `ok`. */
async function until(ok: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await ok()) return;
    await Bun.sleep(250);
  }
  throw new Error(`never happened: ${what}`);
}

async function openOcrWindow(page: Page): Promise<void> {
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForSelector(".ocr-row");
}

async function openProofWindow(page: Page): Promise<void> {
  await openOcrWindow(page);
  await page.click(".ocr-row .ocr-proof");
  await page.waitForFunction((n) => document.querySelectorAll(".proof-row").length === n, PAGES);
}

const state = (n: number) => `.proof-row:nth-child(${n}) .proof-state`;
const textOf = (n: number) => `.proof-row:nth-child(${n}) .proof-text`;
const saved = (page: Page, n: number) => page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(n));

e2e("a page is saved by itself as it is typed, searched at once, kept when the window is closed in a hurry, and taken back with a button", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await openProofWindow(page);

  // a page nobody had read
  await page.fill(textOf(2), "Написано вручную про конденсатор");
  expect(await page.textContent(state(2))).toBe("Not saved yet");
  await saved(page, 2);
  expect(await page.textContent(".proof-stats")).toBe(`Recognized pages: 4 of ${PAGES} · corrected: 2`);
  expect(await page.isVisible(`.proof-row:nth-child(2) .proof-restore`)).toBe(true);
  expect(await page.$$eval(".proof-badge:not([hidden])", (n) => n.length)).toBe(2);
  expect((await held()).items.find((i) => i.page === 2)).toEqual({ page: 2, text: "Написано вручную про конденсатор", edited: true });
  expect(await found("конденсатор")).toEqual([id]); // searched at once
  await page.fill(textOf(2), "Написано вручную про конденсатор!"); // one more mark typed, then taken back: nothing is left unsaved
  expect(await page.textContent(state(2))).toBe("Not saved yet");
  await page.fill(textOf(2), "Написано вручную про конденсатор");
  expect(await page.textContent(state(2))).toBe("Saved");

  // a page typed over and the window closed before the pause is over: nothing is lost
  await page.fill(textOf(1), "Первая страница, правка перед закрытием");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".proof"));
  await until(async () => (await held()).items[0]!.text === "Первая страница, правка перед закрытием", "the page typed last was saved");

  // taking back: a page nobody had read becomes unread, a page that was read gets its reading back
  await openProofWindow(page);
  expect(await page.inputValue(textOf(1))).toBe("Первая страница, правка перед закрытием");
  await page.click(`.proof-row:nth-child(2) .proof-restore`);
  await page.waitForFunction((n) => document.querySelector(".proof-stats")?.textContent === `Recognized pages: 3 of ${n} · corrected: 2`, PAGES);
  expect(await page.inputValue(textOf(2))).toBe("");
  expect(await page.getAttribute(textOf(2), "placeholder")).toBe("This page has not been recognized yet.");
  expect(await page.isVisible(`.proof-row:nth-child(2) .proof-restore`)).toBe(false);
  expect(await found("конденсатор")).toEqual([]);
  expect((await held()).items.map((i) => i.page)).toEqual([1, 3, 12]);

  expect(await found("осциллограф")).toEqual([id]); // page 3 was corrected before the window ever opened
  await page.click(`.proof-row:nth-child(3) .proof-restore`);
  await page.waitForFunction((n) => document.querySelector(".proof-stats")?.textContent === `Recognized pages: 3 of ${n} · corrected: 1`, PAGES);
  expect(await page.inputValue(textOf(3))).toBe("С ошибкой в слове осцилограф");
  expect(await found("осциллограф")).toEqual([]);
  expect(await found("осцилограф")).toEqual([id]);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a page that could not be sent is tried again by itself", async () => {
  const page = await ctx.newPage();
  await openProofWindow(page);
  let failed = 0;
  await page.route("**/api/admin/ocr/*/edit/*", (route) => (route.request().method() === "PUT" && failed++ === 0 ? route.abort() : route.continue()));
  await page.fill(textOf(12), "Последняя страница, правка с перебоем в сети");
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Not saved, trying again…", state(12), { timeout: 10_000 });
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(12), { timeout: 15_000 });
  expect((await held()).items.find((i) => i.page === 12)!.text).toBe("Последняя страница, правка с перебоем в сети");
  await page.close();
});

e2e("a page can be jumped to, and forgetting the text of a book with corrections says what will be lost", async () => {
  const page = await ctx.newPage();
  await openProofWindow(page);
  await page.fill(".proof-goto", String(PAGES));
  await page.keyboard.press("Enter");
  await page.waitForSelector(`.proof-row:nth-child(${PAGES}) .proof-canvas`);
  expect(await page.$eval(".proof-pages", (s) => s.scrollTop)).toBeGreaterThan(1000);
  await page.fill(".proof-goto", "1");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (document.querySelector(".proof-pages") as HTMLElement).scrollTop === 0);

  await openOcrWindow(page); // a fresh look at what the server holds
  const edited = (await held()).edited;
  expect(edited).toBeGreaterThan(0);
  let asked = "";
  page.once("dialog", (dialog) => {
    asked = dialog.message();
    void dialog.dismiss();
  });
  await page.click(".ocr-row .ocr-forget");
  expect(asked).toContain(`${edited} pages you corrected by hand`);
  expect((await held()).done).toBeGreaterThan(0); // dismissed: nothing was forgotten
  await page.close();
});
