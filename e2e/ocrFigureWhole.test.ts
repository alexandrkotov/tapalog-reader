import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/whole.pdf": scanPdf([picture!, picture!, picture!], PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, { width: 1200, height: 700 }); // a window in which a page does not fit by height
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const textOf = (n: number) => `.proof-row:nth-child(${n}) .proof-text`;

async function openProof(page: Page): Promise<void> {
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('whole') .card-info");
  await page.click(".card:has-text('whole') .card-info");
  await page.waitForSelector(".card-form");
  await page.click(".card-proof");
  await page.waitForFunction(() => document.querySelectorAll(".proof-row").length === 3);
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
  await page.waitForSelector(".proof-row:nth-child(2) .proof-canvas"); // pages are drawn one after another, a slow machine has not reached the second yet
}

/** The size of a picture kept with the book. */
async function sizeOf(page: Page, name: string): Promise<{ width: number; height: number }> {
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    return { width: bitmap.width, height: bitmap.height };
  }, `${inst.url}/api/admin/ocr/${await bookId(ctx, inst, "Scans/whole.pdf")}/images/${name}`);
}

e2e("a page is cut whole as a figure by one button, whatever the size of the window, and is put into the text at the cursor", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  // the window is too low for a page: its scan is taller than the list
  const [scan, list] = await page.evaluate(() => [document.querySelector(".proof-row:nth-child(2) .proof-canvas")!.getBoundingClientRect().height, document.querySelector(".proof-pages")!.getBoundingClientRect().height]);
  expect(scan!).toBeGreaterThan(list! * 1.2);

  await page.evaluate((sel) => {
    const field = document.querySelector(sel) as HTMLTextAreaElement;
    field.value = "Перед рисунком.";
    field.setSelectionRange(field.value.length, field.value.length);
  }, textOf(2));
  expect(await page.getAttribute(".proof-row:nth-child(2) .proof-whole", "title")).toBe("Cut the whole page as one figure and put it into the text where the cursor is.");
  await page.click(".proof-row:nth-child(2) .proof-whole"); // no mode to turn on, no frame to draw
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLTextAreaElement).value.includes("![Fig. 2.1](images/p002-1.png)"), textOf(2));
  expect(await page.inputValue(textOf(2))).toBe("Перед рисунком.\n\n![Fig. 2.1](images/p002-1.png)");
  await page.waitForSelector(".proof-row:nth-child(2) .proof-fig");

  // the picture is the whole page: its proportions, at the most the limit allows on its longer side
  const picture = await sizeOf(page, "p002-1.png");
  expect(picture.height).toBe(3200);
  expect(Math.abs(picture.width - (3200 * PAGE_W) / PAGE_H)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a frame can be drawn down past the edge of the window: the list scrolls by itself while the pointer waits at its edge", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  await page.click(".proof-figure");
  const canvas = (await (await page.$(".proof-row:nth-child(1) .proof-canvas"))!.boundingBox())!;
  const list = (await (await page.$(".proof-pages"))!.boundingBox())!;
  expect(canvas.y + canvas.height).toBeGreaterThan(list.y + list.height); // the bottom of the page is out of sight

  await page.mouse.move(canvas.x + 10, canvas.y + 10);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width - 4, list.y + list.height - 20, { steps: 6 });
  // the pointer stays where it is; the list goes down by itself and the frame grows with it, to the foot of the page
  await page.waitForFunction(() => {
    const rect = document.querySelector(".proof-rect") as HTMLElement | null;
    const page = document.querySelector(".proof-row:nth-child(1) .proof-canvas") as HTMLElement;
    return !!rect && rect.getBoundingClientRect().height > page.getBoundingClientRect().height * 0.97;
  });
  expect(await page.$eval(".proof-pages", (s) => s.scrollTop)).toBeGreaterThan(100);
  await page.mouse.up();
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLTextAreaElement).value.includes("![Fig. 1.1](images/p001-1.png)"), textOf(1));

  // almost the whole height of the page, which a frame drawn on the visible part alone could never be
  const picture = await sizeOf(page, "p001-1.png");
  expect(picture.height).toBeGreaterThan(3000);
  expect(picture.height).toBeLessThanOrEqual(3200);
  expect(await page.$(".proof-rect")).toBeNull();
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a pointer in the middle of the list does not scroll it, and a click is still not a frame", async () => {
  const page = await ctx.newPage();
  await openProof(page);
  await page.click(".proof-figure");
  const figures = () => page.$$eval(".proof-row:nth-child(1) .proof-fig", (n) => n.length);
  const had = await figures(); // the book keeps the figure of the test before
  const canvas = (await (await page.$(".proof-row:nth-child(1) .proof-canvas"))!.boundingBox())!;
  await page.mouse.move(canvas.x + 30, canvas.y + 30);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 200, canvas.y + 120, { steps: 4 });
  await page.waitForTimeout(300);
  expect(await page.$eval(".proof-pages", (s) => s.scrollTop)).toBe(0);
  await page.mouse.up();
  await page.mouse.click(canvas.x + 50, canvas.y + 50); // a click: nothing is cut
  await page.waitForTimeout(300);
  expect(await figures()).toBe(had + 1); // only the frame above made a figure
  await page.close();
});
