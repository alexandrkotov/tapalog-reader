import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const pictures = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"], ["Vacuum tube amplifier", "for the workshop of a beginner"]]);
  inst = await startServer({ "Scans/first.pdf": scanPdf(pictures, PAGE_W, PAGE_H), "Scans/second.pdf": scanPdf([...pictures].reverse(), PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("several books read in one go share the readers: they are made for the first book, not again for each, and all of them are ended with the run", async () => {
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  for (let i = 0; ; i++) {
    if ((await api<{ books: unknown[] }>(ctx, inst, "/api/admin/ocr")).books.length === 2) break;
    if (i > 120) throw new Error("the scans were never found");
    await Bun.sleep(250);
  }
  const page = await ctx.newPage();
  const errors = watchErrors(page, /Estimating resolution|Detected \d+ diacritics/);
  // every reader the page starts, and every one it ends: the engine runs each from a blob (pdf.js's own worker is a file)
  await page.addInitScript(() => {
    const W = window.Worker;
    const log = ((window as unknown as { __workers: { started: number; ended: number } }).__workers = { started: 0, ended: 0 });
    window.Worker = class extends W {
      private reader: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.reader = String(url).startsWith("blob:");
        if (this.reader) log.started++;
      }
      override terminate(): void {
        if (this.reader) {
          this.reader = false;
          log.ended++;
        }
        super.terminate();
      }
    };
  });
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForFunction(() => document.querySelectorAll(".ocr-row").length === 2);
  await page.selectOption(".ocr-lang", "rus+eng");
  await page.check(".ocr-row:has(.ocr-title:text-is('first')) input");
  await page.check(".ocr-row:has(.ocr-title:text-is('second')) input");
  const lanes = await page.evaluate(() => Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)));

  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Done"), undefined, { timeout: 110_000 });
  expect(await page.textContent(".ocr-message")).toBe("Done: 4 pages recognized.");
  // a book of two pages never needs more than two readers; the second book finds them made
  const log = await page.evaluate(() => (window as unknown as { __workers: { started: number; ended: number } }).__workers);
  expect(log.started).toBe(Math.min(lanes, 2));
  expect(log.ended).toBe(log.started);
  const found = (await api<{ books: unknown[] }>(ctx, inst, "/api/fulltext?q=" + encodeURIComponent("радиоприёмник"))).books;
  expect(found).toHaveLength(2); // both books were read, the second with the readers of the first
  expect(errors).toEqual([]);
  await page.close();
});
