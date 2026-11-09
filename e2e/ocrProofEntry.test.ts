import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/fresh.pdf": scanPdf([picture!, picture!, picture!], PAGE_W, PAGE_H), "Scans/note.txt": "no pictures here" });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const state = (n: number) => `.proof-row:nth-child(${n}) .proof-state`;
const textOf = (n: number) => `.proof-row:nth-child(${n}) .proof-text`;
const saved = (page: Page, n: number) => page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(n));

async function download(page: Page, format: "md" | "txt"): Promise<{ name: string; text: string }> {
  const [file] = await Promise.all([page.waitForEvent("download"), page.click(`.proof-download-${format}`)]);
  return { name: file.suggestedFilename(), text: readFileSync((await file.path())!, "utf8") };
}

e2e("a PDF's card opens the scan beside its text even if the book was never recognized: pages are written by hand, and the book is saved as a file", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('fresh') .card-info");
  await page.click(".card:has-text('fresh') .card-info");
  await page.waitForSelector(".card-form");
  expect(await page.$$(".card-proof")).toHaveLength(1);
  await page.click(".card-proof");
  await page.waitForFunction(() => document.querySelectorAll(".proof-row").length === 3);

  // nothing is on the server yet: empty pages, nothing to download, and the book is not listed as started
  expect(await page.textContent(".proof-stats")).toBe("Recognized pages: 0 of 3");
  expect(await page.$$eval(".proof-text", (n) => n.every((x) => (x as HTMLTextAreaElement).value === ""))).toBe(true);
  expect(await page.isVisible(".proof-download-md")).toBe(false);
  expect((await api<{ books: unknown[] }>(ctx, inst, "/api/admin/ocr")).books).toEqual([]);

  // the first page typed starts the book, and the downloads appear
  await page.fill(textOf(2), "Вторая страница написана вручную");
  await saved(page, 2);
  expect(await page.textContent(".proof-stats")).toBe("Recognized pages: 1 of 3 · corrected: 1");
  expect(await page.isVisible(".proof-download-md")).toBe(true);
  expect((await api<{ books: { done: number; edited: number; pages: number }[] }>(ctx, inst, "/api/admin/ocr")).books).toMatchObject([{ pages: 3, done: 1, edited: 1 }]);

  const md = await download(page, "md");
  expect(md.name).toBe("fresh.md");
  expect(md.text).toBe("# fresh\n\n> Recognized pages: 1 of 3.\n\n## Page 2\n\nВторая страница написана вручную\n");

  // a page typed a moment ago is in the file too: the download waits for it
  await page.fill(textOf(3), "Третья тоже");
  const txt = await download(page, "txt");
  expect(txt.name).toBe("fresh.txt");
  expect(txt.text).toBe("fresh\n\nRecognized pages: 2 of 3.\n\n[Page 2]\n\nВторая страница написана вручную\n\n[Page 3]\n\nТретья тоже\n");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("the button is on a PDF's card only, and only the administrator sees it", async () => {
  await api(ctx, inst, "/api/admin/users", { name: "Reader", password: "pin123", role: "user" });
  const page = await ctx.newPage();
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('note') .card-info");
  await page.click(".card:has-text('note') .card-info");
  await page.waitForSelector(".card-form");
  expect(await page.$(".card-proof")).toBeNull(); // a text file has no scan
  await page.keyboard.press("Escape");
  await page.close();

  const readerCtx = await signedIn(browser, inst, { name: "Reader", password: "pin123" });
  const reader = await readerCtx.newPage();
  await reader.goto(inst.url + "/#folder=Scans");
  await reader.waitForSelector(".card:has-text('fresh') .card-info");
  await reader.click(".card:has-text('fresh') .card-info");
  await reader.waitForSelector(".modal .reader-title");
  expect(await reader.$(".card-proof")).toBeNull();
  await readerCtx.close();
});
