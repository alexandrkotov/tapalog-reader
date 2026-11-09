import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let id = "";

before(async () => {
  browser = await launch();
  const [one, two] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"], ["Vacuum tube amplifier", "for the workshop of a beginner"]]);
  inst = await startServer({ "Scans/old.pdf": scanPdf([one!, two!, one!], PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  id = await bookId(ctx, inst, "Scans/old.pdf");
  // a book read by an older program: the text of every page, and no frames of words; page 3 has since been written by hand
  const send = (path: string, method: string, body: unknown) => ctx.request.fetch(`${inst.url}/api/admin/ocr/${id}${path}`, { method, data: body, headers: { Origin: inst.url } });
  await send("/start", "POST", { pages: 3, lang: "rus" });
  await send("/pages/1", "PUT", { text: "Ламповый радиоприёмник для начинающих радиолюбителей" });
  await send("/pages/2", "PUT", { text: "Vacuum tube amplifier for the workshop of a beginner" });
  await send("/pages/3", "PUT", { text: "Ламповый радиоприёмник" });
  await send("/edit/3", "PUT", { text: "Исправлено вручную" });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("a book recognized before the words could be selected is offered for a second reading of the pages that lack them, which leaves what was written by hand alone", async () => {
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  const page = await ctx.newPage();
  const errors = watchErrors(page, /Estimating resolution|Detected \d+ diacritics/);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForSelector(".ocr-row");

  // the list says which pages cannot be selected as text: those the recognizer read, not the one written by hand
  expect(await page.textContent(".ocr-row .ocr-status")).toBe("Recognized, 3 pages · 2 pages without selectable text");
  expect(await page.isChecked(".ocr-again")).toBe(false);
  expect(await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes`).then((r) => r.json())).toEqual({ pages: [] });

  // a plain run does what it always did: nothing is left to read, so nothing is read
  await page.check(".ocr-row input[type=checkbox]");
  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Done"), undefined, { timeout: 60_000 });
  expect(await page.textContent(".ocr-message")).toBe("Done: 0 pages recognized.");
  expect(await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes`).then((r) => r.json())).toEqual({ pages: [] });

  // the button ticks the books that have such pages and turns the second reading on
  await page.uncheck(".ocr-row input[type=checkbox]");
  await page.selectOption(".ocr-lang", "rus+eng"); // page 2 is in English
  await page.click(".ocr-select-plain");
  expect(await page.isChecked(".ocr-again")).toBe(true);
  expect(await page.isChecked(".ocr-row input[type=checkbox]")).toBe(true);
  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Done"), undefined, { timeout: 80_000 });
  expect(await page.textContent(".ocr-message")).toBe("Done: 2 pages recognized.");
  expect(await page.textContent(".ocr-row .ocr-status")).toBe("Recognized, 3 pages"); // nothing left to take up
  expect(await page.isHidden(".ocr-select-plain")).toBe(true);

  // the pages that were read again have their words, in reading order; the page written by hand has none and keeps its text
  expect(await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes`).then((r) => r.json())).toEqual({ pages: [1, 2] });
  const first = (await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes/1`).then((r) => r.json())) as { boxes: [string, number, number, number, number][] };
  expect(first.boxes[0]![0].toLowerCase()).toContain("лампов");
  const kept = (await api<{ items: { page: number; text: string; edited: boolean }[] }>(ctx, inst, `/api/admin/ocr/${id}/pages`)).items;
  expect(kept.find((p) => p.page === 3)).toMatchObject({ text: "Исправлено вручную", edited: true });
  expect(kept.find((p) => p.page === 2)!.text.toLowerCase()).toContain("amplifier");
  expect(errors).toEqual([]);
  await page.close();
});
