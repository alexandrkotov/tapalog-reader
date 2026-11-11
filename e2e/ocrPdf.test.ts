import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { inspectPdf } from "./pdfInfo";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/export.pdf": scanPdf([picture!, picture!, picture!], PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, { width: 1300, height: 800 });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const textOf = (n: number) => `.proof-row:nth-child(${n}) .proof-text`;
const state = (n: number) => `.proof-row:nth-child(${n}) .proof-state`;

async function exported(page: Page): Promise<{ name: string; bytes: Uint8Array }> {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.click(".proof-pdf-run")]);
  return { name: file.suggestedFilename(), bytes: new Uint8Array(readFileSync((await file.path())!)) };
}

e2e("the text and figures of a book are made into a new PDF that is only downloaded: set in the letters of the book, with the figure drawn, and the sheet and headings chosen", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('export') .card-info");
  await page.click(".card:has-text('export') .card-info");
  await page.waitForSelector(".card-form");
  await page.click(".card-proof");
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");

  // a book that was never started has nothing to export: the button comes with the first page saved
  expect(await page.isVisible(".proof-pdf-open")).toBe(false);
  await page.fill(textOf(1), "Ламповый радиоприёмник для начинающих.\n\nВторой абзац с «кавычками», номером № 5 и ёлкой.");
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(1));
  expect(await page.isVisible(".proof-pdf-open")).toBe(true);
  expect(await page.isVisible(".proof-pdf-run")).toBe(false); // the choices open on demand

  await page.fill(textOf(2), "Вторая страница.\nСтрока, набранная вручную отдельно.");
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(2));
  await page.$eval(".proof-pages", (s) => (s.scrollTop = 0));
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
  await page.waitForTimeout(300);

  // a figure on the first page
  await page.click(".proof-figure");
  const box = (await (await page.$(".proof-row:nth-child(1) .proof-canvas"))!.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLTextAreaElement).value.includes("images/p001-1.png"), textOf(1));
  await page.keyboard.press("Escape");
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(1));

  // the choices: A4 and headings are the first
  await page.click(".proof-pdf-open");
  expect(await page.inputValue(".proof-pdf-format")).toBe("a4");
  expect(await page.isChecked(".proof-pdf-headings")).toBe(true);
  const first = await exported(page);
  expect(first.name).toBe("export.pdf");
  await page.waitForFunction(() => /^Saved export\.pdf \(\d+ KB\)$/.test(document.querySelector(".proof-pdf-state")?.textContent ?? ""));
  const a4 = await inspectPdf(first.bytes);
  expect(a4.title).toBe("export");
  expect(a4.pages).toHaveLength(1);
  expect(a4.pages[0]!.width).toBeCloseTo(595.28, 1);
  expect(a4.pages[0]!.height).toBeCloseTo(841.89, 1);
  expect(a4.pages[0]!.images).toBe(1); // the figure
  expect(a4.pages[0]!.text).toEqual([
    "export",
    "Recognized pages: 2 of 3.", // the note: the book is not whole
    "Page 1",
    "Ламповый радиоприёмник для начинающих.",
    "Второй абзац с «кавычками», номером № 5 и ёлкой.",
    "Page 2",
    "Вторая страница.",
    "Строка, набранная вручную отдельно.",
    "1 / 1",
  ]);

  // another sheet and no headings; the choices are kept for the next time
  await page.selectOption(".proof-pdf-format", "a5");
  await page.uncheck(".proof-pdf-headings");
  const second = await exported(page);
  const a5 = await inspectPdf(second.bytes);
  expect(a5.pages[0]!.width).toBeCloseTo(419.53, 1);
  expect(a5.pages.flatMap((p) => p.text)).not.toContain("Page 1");
  expect(a5.pages.flatMap((p) => p.text)).toContain("Вторая страница.");
  expect(a5.pages.reduce((n, p) => n + p.images, 0)).toBe(1);
  expect(await page.evaluate(() => [localStorage.getItem("tapalog.pdfFormat"), localStorage.getItem("tapalog.pdfHeadings")])).toEqual(["a5", "0"]);

  // the PDF is only downloaded: the library has no new file, and the book's own file is as it was
  const books = (await api<{ books: { path: string }[] }>(ctx, inst, "/api/library")).books.map((b) => b.path);
  expect(books).toEqual(["Scans/export.pdf"]);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("when the library that writes the PDF cannot be fetched the export says so, and the next try fetches it again", async () => {
  const page = await ctx.newPage();
  await page.route("**/pdflib/**", (route) => route.abort());
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('export') .card-info");
  await page.click(".card:has-text('export') .card-info");
  await page.waitForSelector(".card-form");
  await page.click(".card-proof");
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
  await page.click(".proof-pdf-open");
  await page.click(".proof-pdf-run");
  await page.waitForFunction(() => document.querySelector(".proof-pdf-state")?.textContent === "Could not make the PDF");
  expect(await page.isEnabled(".proof-pdf-run")).toBe(true);

  await page.unroute("**/pdflib/**");
  const again = await exported(page);
  expect((await inspectPdf(again.bytes)).pages.length).toBeGreaterThan(0);
  await page.close();
});

e2e("the marks of bold, headings, lists and formulas are not printed into the PDF: the words come out set as the marks say, a formula as its LaTeX, a price as it was typed", async () => {
  const page = await ctx.newPage();
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('export') .card-info");
  await page.click(".card:has-text('export') .card-info");
  await page.waitForSelector(".card-form");
  await page.click(".card-proof");
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
  await page.fill(textOf(1), "### Заголовок раздела\n\n**Жирный** и *курсивный* текст, цена $5, площадь $S=\\pi r^2$.\n\n- первый пункт\n- второй пункт\n\n> чужая мысль\n\n$$\nE=mc^2\n$$");
  await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(1));
  await page.click(".proof-pdf-open");
  const { bytes } = await exported(page);
  const pdf = await inspectPdf(bytes);
  const pieces = pdf.pages.flatMap((p) => p.text);
  const flat = pieces.join(" ").replace(/\s+/g, " ");
  expect(flat).toContain("Заголовок раздела");
  expect(flat).toContain("Жирный и курсивный текст, цена $5, площадь");
  expect(pieces).toContain("S=\\pi r^2"); // a formula is a piece of its own, in italics
  expect(flat).toContain("первый пункт");
  expect(flat).toContain("чужая мысль");
  expect(flat).toContain("E=mc^2");
  expect(flat).toContain("• первый пункт");
  for (const mark of ["**", "###", "$$", "$S", "r^2$", "> "]) expect(flat).not.toContain(mark);
  await page.close();
});

e2e("a book with nothing to put into a PDF says so instead of making an empty file", async () => {
  const page = await ctx.newPage();
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('export') .card-info");
  await page.click(".card:has-text('export') .card-info");
  await page.waitForSelector(".card-form");
  await page.click(".card-proof");
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
  // empty every page that has text (a page erased by hand is still an entry, with no text)
  for (const n of [1, 2]) {
    await page.fill(textOf(n), "");
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "Saved", state(n));
  }
  await page.click(".proof-pdf-open");
  await page.click(".proof-pdf-run");
  await page.waitForFunction(() => /no text or figure/.test(document.querySelector(".proof-pdf-state")?.textContent ?? ""));
  await page.close();
});
