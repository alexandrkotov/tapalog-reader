import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const pictures = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"], ["Vacuum tube amplifier", "for the workshop of a beginner"]]);
  const many = Array.from({ length: 6 }, (_, i) => pictures[i % 2]!);
  inst = await startServer({ "Scans/short.pdf": scanPdf(pictures, PAGE_W, PAGE_H), "Scans/long.pdf": scanPdf(many, PAGE_W, PAGE_H), "Scans/note.txt": "no pictures here" });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

/** Search inside books on, and the indexer has found both scans. */
async function scansListed(): Promise<void> {
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  for (let i = 0; i < 120; i++) {
    if ((await api<{ books: unknown[] }>(ctx, inst, "/api/admin/ocr")).books.length === 2) return;
    await Bun.sleep(250);
  }
  throw new Error("the scans were never found");
}

const row = (name: string) => `.ocr-row:has(.ocr-title:text-is('${name}'))`;

e2e("the administrator reads a scan from Settings, sees how far it has got, stops another, and can forget what was read", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page, /Estimating resolution|Detected \d+ diacritics/); // the engine reports what it measured on a page
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");

  // the reading of scans is offered once search inside books is on
  expect(await page.$("button:has-text('Read scanned pages')")).toBeNull();
  await page.check(".section:has(h3:text-is('Search inside books')) input[type=checkbox]");
  await scansListed(); // the books are read in the background: the scans are known a moment later
  await page.click("button:has-text('Read scanned pages')");
  await page.waitForSelector(".ocr-list .ocr-row");
  await page.waitForFunction(() => document.querySelectorAll(".ocr-row").length === 2); // the two scans; the text file is not offered
  expect(await page.$$eval(".ocr-title", (n) => n.map((x) => x.textContent))).toEqual(["long", "short"]);
  expect(await page.textContent(`${row("short")} .ocr-status`)).toBe("Not read");
  expect(await page.isDisabled(".ocr-actions .btn.primary")).toBe(true); // nothing chosen yet

  // the short one is read to the end
  await page.check(`${row("short")} input`);
  await page.selectOption(".ocr-lang", "rus+eng");
  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Done"), undefined, { timeout: 80_000 });
  expect(await page.textContent(".ocr-message")).toBe("Done: 2 pages read.");
  expect(await page.textContent(`${row("short")} .ocr-status`)).toBe("Read, 2 pages");
  expect(await page.textContent(".ocr-kept")).toBe("Kept: the text of 2 pages of 1 books.");
  const shortId = await bookId(ctx, inst, "Scans/short.pdf");
  const found = (await api<{ books: { id: string }[] }>(ctx, inst, "/api/fulltext?q=" + encodeURIComponent("радиоприёмник"))).books;
  expect(found.map((b) => b.id)).toEqual([shortId]); // search finds it

  // the long one is stopped as soon as it has begun: nothing is read, nothing is lost
  await page.check(`${row("long")} input`);
  await page.click(".ocr-actions .btn.primary");
  await page.waitForFunction(() => /page 0 of 6/.test(document.querySelector(".ocr-progress")?.textContent ?? ""), undefined, { timeout: 60_000 });
  await page.click(".ocr-actions .btn:has-text('Stop')");
  await page.waitForFunction(() => document.querySelector(".ocr-message")?.textContent?.startsWith("Stopped"), undefined, { timeout: 60_000 });
  expect(await page.textContent(".ocr-message")).toMatch(/^Stopped: \d pages read; the rest can be read later\.$/);
  expect(await page.isChecked(`${row("long")} input`)).toBe(true); // still ticked: it was not finished

  // forgetting the text of the short one: search stops finding it
  await page.click(`${row("short")} .ocr-forget`);
  await page.waitForSelector(`${row("short")} .ocr-status:text-is('Not read')`);
  const left = (await api<{ books: { id: string }[] }>(ctx, inst, "/api/fulltext?q=" + encodeURIComponent("радиоприёмник"))).books;
  expect(left.some((b) => b.id === shortId)).toBe(false); // (the long one may have had a page or two read before the stop)
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a PDF's own card has a button that opens the reading with that book chosen, and only the administrator sees it", async () => {
  await scansListed();
  const page = await ctx.newPage();
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('short') .card-info");
  await page.click(".card:has-text('short') .card-info");
  await page.waitForSelector(".card-form");
  expect(await page.$$(".card-ocr")).toHaveLength(1);
  await page.click(".card-ocr");
  await page.waitForSelector(".ocr-list .ocr-row");
  expect(await page.isChecked(`${row("short")} input`)).toBe(true);
  expect(await page.isChecked(`${row("long")} input`)).toBe(false);
  await page.keyboard.press("Escape"); // the reading window
  await page.keyboard.press("Escape"); // and the card
  // a text file's card has no such button
  await page.click(".card:has-text('note') .card-info");
  await page.waitForSelector(".card-form");
  expect(await page.$(".card-ocr")).toBeNull();
  await page.keyboard.press("Escape");

  await api(ctx, inst, "/api/admin/users", { name: "Reader", password: "pin123", role: "user" });
  const readerCtx = await signedIn(browser, inst, { name: "Reader", password: "pin123" });
  const reader = await readerCtx.newPage();
  await reader.goto(inst.url + "/#folder=Scans");
  await reader.waitForSelector(".card:has-text('short') .card-info");
  await reader.click(".card:has-text('short') .card-info");
  await reader.waitForSelector(".modal .reader-title");
  expect(await reader.$(".card-ocr")).toBeNull();
  await readerCtx.close();
  await page.close();
});
