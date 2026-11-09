import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/figures.pdf": scanPdf([picture!, picture!, picture!], PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, { width: 1300, height: 800 });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const state = (n: number) => `.proof-row:nth-child(${n}) .proof-state`;
const textOf = (n: number) => `.proof-row:nth-child(${n}) .proof-text`;
const saved = (page: Page, n: number) => page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(n));

/** Drags a frame on the scan of a page; the corners are fractions of the picture. */
async function frame(page: Page, n: number, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await (await page.$(`.proof-row:nth-child(${n}) .proof-canvas`))!.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 4 });
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 });
  await page.mouse.up();
}

e2e("a figure is framed on the scan, cut from the PDF sharper than it is shown, kept with the book, and written into the text at the cursor", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('figures') .card-info");
  await page.click(".card:has-text('figures') .card-info");
  await page.waitForSelector(".card-form");
  await page.click(".card-proof");
  await page.waitForFunction(() => document.querySelectorAll(".proof-row").length === 3);
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");

  // out of the mode a drag on the scan does nothing
  expect(await page.getAttribute(".proof-figure", "aria-pressed")).toBe("false");
  await frame(page, 1, [0.1, 0.1], [0.6, 0.4]);
  expect(await page.$(".proof-rect")).toBeNull();
  expect(await page.inputValue(textOf(1))).toBe("");

  // the mode: a hint, and a click without a frame cuts nothing
  await page.click(".proof-figure");
  expect(await page.getAttribute(".proof-figure", "aria-pressed")).toBe("true");
  expect(await page.isVisible(".proof-hint")).toBe(true);
  const box = (await (await page.$(".proof-row:nth-child(1) .proof-canvas"))!.boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + 40);
  expect(await page.inputValue(textOf(1))).toBe("");
  expect((await api<{ books: unknown[] }>(ctx, inst, "/api/admin/ocr")).books).toEqual([]); // nothing was started

  // text with a cursor in the middle of it, then a frame on the scan
  await page.evaluate((sel) => {
    const field = document.querySelector(sel) as HTMLTextAreaElement;
    field.value = "Начало страницы.\n\nКонец страницы.";
    field.setSelectionRange("Начало страницы.\n\n".length - 2, "Начало страницы.\n\n".length - 2); // right after "страницы."
  }, textOf(1));
  await frame(page, 1, [0.1, 0.1], [0.6, 0.4]);
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLTextAreaElement).value.includes("![Fig. 1.1](images/p001-1.png)"), textOf(1));
  expect(await page.inputValue(textOf(1))).toBe("Начало страницы.\n\n![Fig. 1.1](images/p001-1.png)\n\nКонец страницы.");
  expect(await page.textContent(state(1))).toMatch(/Figure added|Saving|Saved|Not saved yet/);
  await saved(page, 1);

  // the book was started by the first figure, and the picture is the frame's part of the page at a higher resolution
  expect((await api<{ books: { done: number; edited: number }[] }>(ctx, inst, "/api/admin/ocr")).books).toMatchObject([{ pages: 3, done: 1, edited: 1 }]);
  const items = (await api<{ items: { name: string; page: number; size: number }[] }>(ctx, inst, `/api/admin/ocr/${await bookIdOf()}/images`)).items;
  expect(items).toMatchObject([{ name: "p001-1.png", page: 1 }]);
  const info = await page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 100) dark++;
    return { width: bitmap.width, height: bitmap.height, dark };
  }, `${inst.url}/api/admin/ocr/${await bookIdOf()}/images/p001-1.png`);
  expect(info.width).toBeGreaterThan(box.width * 0.5 * 1.5); // sharper than the 50% of the page the screen shows
  expect(info.width / info.height).toBeCloseTo((0.5 * PAGE_W) / (0.3 * PAGE_H), 1); // the proportions of the frame
  expect(info.dark).toBeGreaterThan(50); // the writing of the scan is in it

  // a second figure on the same page is the next number, put in as a paragraph of its own where the cursor is
  await frame(page, 1, [0.5, 0.5], [0.9, 0.8]);
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLTextAreaElement).value.includes("images/p001-2.png"), textOf(1));
  expect((await page.inputValue(textOf(1))).match(/!\[Fig\. 1\.\d\]\(images\/p001-\d\.png\)/g)).toEqual(["![Fig. 1.1](images/p001-1.png)", "![Fig. 1.2](images/p001-2.png)"]);
  await saved(page, 1);

  // the downloads came with the started book: the zip has the Markdown and its pictures
  expect(await page.isVisible(".proof-download-md")).toBe(true);
  const zip = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return { type: res.headers.get("content-type"), size: (await res.arrayBuffer()).byteLength };
  }, `${inst.url}/api/admin/ocr/${await bookIdOf()}/text?format=zip`);
  expect(zip.type).toBe("application/zip");
  expect(zip.size).toBeGreaterThan(info.width);

  // Esc leaves the mode first and only the next one closes the window
  await page.keyboard.press("Escape");
  expect(await page.getAttribute(".proof-figure", "aria-pressed")).toBe("false");
  expect(await page.isVisible(".proof-pages")).toBe(true);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".proof-pages", { state: "detached" });
  expect(errors).toEqual([]);
  await page.close();
});

async function bookIdOf(): Promise<string> {
  const books = (await api<{ books: { id: string; path: string }[] }>(ctx, inst, "/api/library")).books;
  return books.find((b) => b.path === "Scans/figures.pdf")!.id;
}
