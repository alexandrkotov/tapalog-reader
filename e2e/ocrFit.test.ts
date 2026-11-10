import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/fit.pdf": scanPdf([picture!, picture!, picture!], PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, { width: 1200, height: 700 }); // a window in which a page does not fit by height
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

async function openProof(page: Page): Promise<void> {
  await page.goto(inst.url + "/#folder=Scans");
  await page.waitForSelector(".card:has-text('fit') .card-info");
  await page.click(".card:has-text('fit') .card-info");
  await page.waitForSelector(".card-form");
  await page.click(".card-proof");
  await page.waitForFunction(() => document.querySelectorAll(".proof-row").length === 3);
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
}

const geometry = (page: Page) => page.evaluate(() => {
  const list = document.querySelector(".proof-pages")!.getBoundingClientRect();
  const scan = document.querySelector(".proof-row:nth-child(1) .proof-scan")!.getBoundingClientRect();
  const text = document.querySelector(".proof-row:nth-child(1) .proof-text")!.getBoundingClientRect();
  const canvas = document.querySelector(".proof-row:nth-child(1) .proof-canvas") as HTMLCanvasElement;
  return { list: { top: list.top, bottom: list.bottom }, scan: { top: scan.top, bottom: scan.bottom, width: scan.width, height: scan.height }, text: { bottom: text.bottom }, canvasWidth: canvas?.width ?? 0 };
});

e2e("a page can be shown whole in the window, with the text beside it as tall as the scan, and the choice is remembered", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  expect(await page.getAttribute(".proof-fit", "aria-pressed")).toBe("false");
  expect(await page.getAttribute(".proof-fit", "title")).toBe("Show each page whole in the window, with the text beside it as tall as the scan.");
  const usual = await geometry(page);
  expect(usual.scan.bottom).toBeGreaterThan(usual.list.bottom + 50); // as it was: the foot of the page is out of sight

  await page.click(".proof-fit");
  expect(await page.getAttribute(".proof-fit", "aria-pressed")).toBe("true");
  const whole = await geometry(page);
  expect(whole.scan.top).toBeGreaterThanOrEqual(whole.list.top - 1); // the whole page is in the list at once
  expect(whole.scan.bottom).toBeLessThanOrEqual(whole.list.bottom + 1);
  expect(whole.scan.width).toBeLessThan(usual.scan.width); // narrower, as it has to be to be as tall as the list
  expect(Math.abs(whole.scan.width / whole.scan.height - PAGE_W / PAGE_H)).toBeLessThan(0.02); // and still the page's own proportions
  expect(whole.text.bottom).toBeLessThanOrEqual(whole.scan.bottom + 1); // the text is not taller than the scan
  // the scan is drawn again for the room it has now
  await page.waitForFunction((was) => (document.querySelector(".proof-row:nth-child(1) .proof-canvas") as HTMLCanvasElement).width < was * 0.85, usual.canvasWidth);

  // the same place of the book is kept when it is switched: the second page stays at the top
  await page.$eval(".proof-pages", (s) => (s.scrollTop = (s.children[1] as HTMLElement).offsetTop));
  await page.click(".proof-fit");
  const top = () => page.evaluate(() => (document.querySelector(".proof-row:nth-child(2)")!.getBoundingClientRect().top - document.querySelector(".proof-pages")!.getBoundingClientRect().top));
  expect(Math.abs(await top())).toBeLessThan(30);
  expect((await geometry(page)).scan.width).toBeCloseTo(usual.scan.width, 0); // off: as before
  await page.click(".proof-fit");

  // remembered: the window opens the same way next time
  await page.reload();
  await openProof(page);
  expect(await page.getAttribute(".proof-fit", "aria-pressed")).toBe("true");
  const again = await geometry(page);
  expect(again.scan.bottom).toBeLessThanOrEqual(again.list.bottom + 1);

  // a bigger window gives the page more room: it grows with the list
  await page.click(".modal-expand");
  await page.waitForFunction((was) => document.querySelector(".proof-row:nth-child(1) .proof-scan")!.getBoundingClientRect().height > was + 20, again.scan.height);
  const bigger = await geometry(page);
  expect(bigger.scan.bottom).toBeLessThanOrEqual(bigger.list.bottom + 1);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("on a narrow screen, where the scan stands above its text, there is no such switch", async () => {
  const page = await ctx.newPage();
  await openProof(page);
  expect(await page.isVisible(".proof-fit")).toBe(true);
  await page.setViewportSize({ width: 700, height: 800 });
  expect(await page.isVisible(".proof-fit")).toBe(false);
  await page.close();
});
