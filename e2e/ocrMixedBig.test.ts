import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { mixedPdf, PAGE_H, PAGE_W, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

const typeset = (n: number) => ({ lines: [`Paragraph ${n} describes how the output transformer is wound`, `and why the primary has more turns than the secondary of it`, `so that the anode of the tube sees a load of several kilo-ohms`] });

before(async () => {
  browser = await launch();
  const pictures = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"], ["Схема второго каскада", "усилителя низкой частоты"], ["Приложение с таблицей", "данных о лампах"]]);
  // a handbook of 27 pages: 24 typeset (over 2000 letters, so it is no scan by that measure) and the last 3 are pictures
  const handbook = mixedPdf([...Array.from({ length: 24 }, (_, i) => typeset(i + 1)), ...pictures.map((picture) => ({ picture }))], PAGE_W, PAGE_H);
  // a typeset book with one blank page: nothing to offer
  const plain = mixedPdf([...Array.from({ length: 24 }, (_, i) => typeset(i + 1)), { lines: [] }], PAGE_W, PAGE_H);
  inst = await startServer({ "Books/handbook.pdf": handbook, "Books/plain.pdf": plain });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("a big book with a few pictures among typeset pages is offered by itself, says how many pages are pictures, and only those are read", async () => {
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  for (let i = 0; ; i++) {
    const s = await api<{ total: number; indexed: number; skipped: number; failed: number; working: string | null }>(ctx, inst, "/api/admin/fulltext");
    if (s.total === 2 && s.indexed + s.skipped + s.failed === 2 && !s.working) break;
    if (i > 240) throw new Error("the books were never indexed");
    await Bun.sleep(250);
  }
  // the page counts are told before anything is read; the book with one blank page is not offered
  let listed: { title: string; pages: number | null; textPages: number | null; done: number }[] = [];
  for (let i = 0; i < 120 && !listed.length; i++) {
    listed = (await api<{ books: typeof listed }>(ctx, inst, "/api/admin/ocr")).books;
    if (!listed.length) await Bun.sleep(250);
  }
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ title: "handbook", pages: 27, textPages: 24, done: 0 });

  const page = await ctx.newPage();
  const errors = watchErrors(page, /Estimating resolution|Detected \d+ diacritics/);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForFunction(() => document.querySelectorAll(".ocr-row").length === 1);
  expect(await page.textContent(".ocr-status")).toBe("Not recognized · 3 of 27 pages have no text");
  expect(await page.$$eval(".ocr-sort option", (o) => o.map((x) => (x as HTMLOptionElement).value))).toContain("pages");
  await page.selectOption(".ocr-sort", "pages");

  await page.selectOption(".ocr-lang", "rus+eng");
  await page.check(".ocr-row input");
  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Done"), undefined, { timeout: 110_000 });
  expect(await page.textContent(".ocr-message")).toBe("Done: 3 pages recognized. 24 pages with their own text were taken as they are.");
  expect(await page.textContent(".ocr-status")).toBe("Recognized, 27 pages · 24 pages with the text of the PDF");
  expect(errors).toEqual([]);
  await page.close();
});
