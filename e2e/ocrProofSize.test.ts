import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

const PAGES = 6;
const GAP = 24;
const VIEW = { width: 1800, height: 900 };

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/size.pdf": scanPdf(Array.from({ length: PAGES }, () => picture!), PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, VIEW);
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  const id = await bookId(ctx, inst, "Scans/size.pdf");
  await api(ctx, inst, `/api/admin/ocr/${id}/start`, { pages: PAGES, lang: "rus" });
  await ctx.request.put(`${inst.url}/api/admin/ocr/${id}/pages/1`, { data: { text: "Ламповый радиоприёмник для начинающих радиолюбителей" }, headers: { Origin: inst.url } });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

async function openProof(page: Page): Promise<void> {
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForSelector(".ocr-row");
  await page.click(".ocr-row .ocr-proof");
  await page.waitForFunction((n) => document.querySelectorAll(".proof-row").length === n, PAGES);
  await page.waitForSelector(".proof-row:nth-child(1) .proof-canvas");
}

const rect = (page: Page) => page.$eval(".modal.proof", (e) => {
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const canvasWidth = (page: Page) => page.$eval(".proof-row:nth-child(1) .proof-canvas", (c) => (c as HTMLCanvasElement).width);
const near = (a: number, b: number, by = 2) => expect(Math.abs(a - b)).toBeLessThanOrEqual(by);

async function drag(page: Page, grip: string, dx: number, dy: number): Promise<void> {
  const box = (await (await page.$(`.modal-grip[data-grip="${grip}"]`))!.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up();
}

e2e("the window for checking the text can be made almost as big as the screen and back, and stays a window over the page", async () => {
  const page = await ctx.newPage();
  await page.setViewportSize(VIEW);
  const errors = watchErrors(page);
  await openProof(page);

  // as it always was: not wider than 1400 px, as tall as 88% of the screen, in the middle
  const usual = await rect(page);
  near(usual.w, 1400);
  near(usual.h, 0.88 * VIEW.height);
  near(usual.x + usual.w / 2, VIEW.width / 2);
  expect(await page.getAttribute(".modal-expand", "title")).toBe("Make the window bigger");
  expect(await page.getAttribute(".modal-expand", "aria-pressed")).toBe("false");
  const before = await canvasWidth(page);

  // bigger: a space is left on every side, the page behind is still there under the dimming
  await page.click(".modal-expand");
  const big = await rect(page);
  near(big.x, GAP);
  near(big.y, GAP);
  near(big.w, VIEW.width - 2 * GAP);
  near(big.h, VIEW.height - 2 * GAP);
  expect(await page.getAttribute(".modal-expand", "title")).toBe("Back to the usual size");
  expect(await page.getAttribute(".modal-expand", "aria-pressed")).toBe("true");
  expect(await page.isVisible(".modal-backdrop.sizable")).toBe(true);
  // the scans are drawn again for the room they have now, so they stay sharp
  await page.waitForFunction((was) => (document.querySelector(".proof-row:nth-child(1) .proof-canvas") as HTMLCanvasElement).width > was * 1.15, before);

  // back to the usual size by the button, and bigger again by a double click on the title
  await page.click(".modal-expand");
  const back = await rect(page);
  near(back.w, usual.w);
  near(back.h, usual.h);
  await page.dblclick(".modal.proof .modal-head h2");
  near((await rect(page)).w, VIEW.width - 2 * GAP);
  await page.dblclick(".modal.proof .modal-head h2");
  near((await rect(page)).w, usual.w);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("the window can be stretched by its frame, stays in the middle, keeps the place in the book, and remembers its size", async () => {
  const page = await ctx.newPage();
  await page.setViewportSize(VIEW);
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.evaluate(() => localStorage.removeItem("tapalog.proofSize")); // the earlier test left its choice
  await openProof(page);
  const start = await rect(page);

  // the right edge goes out by 100 px: the window grows by 200 and stays centred
  await drag(page, "e", 100, 0);
  const wider = await rect(page);
  near(wider.w, start.w + 200);
  near(wider.h, start.h);
  near(wider.x + wider.w / 2, VIEW.width / 2);
  // the bottom edge goes in by 60 px, the corner out in both directions
  await drag(page, "s", 0, -60);
  near((await rect(page)).h, start.h - 120);
  await drag(page, "se", 40, 20);
  const shaped = await rect(page);
  near(shaped.w, wider.w + 80);
  near(shaped.h, start.h - 120 + 40);
  // the window was not closed by the drag, and it cannot be made smaller than its smallest size nor bigger than the screen
  expect(await page.isVisible(".modal.proof")).toBe(true);
  await drag(page, "w", 2000, 0);
  near((await rect(page)).w, 640);
  await drag(page, "e", 3000, 0);
  near((await rect(page)).w, VIEW.width - 2 * GAP);

  // a size of its own is remembered: after closing and opening the window again it is the same
  await drag(page, "w", 150, 0);
  const chosen = await rect(page);
  await page.keyboard.press("Escape"); // closes this window and the list under it
  await page.waitForSelector(".modal.proof", { state: "detached" });
  await openProof(page);
  const again = await rect(page);
  near(again.w, chosen.w);
  near(again.h, chosen.h);

  // while the window changes its size, the list stays at the same place of the book
  await page.click(".modal-expand"); // bigger
  await page.waitForFunction((n) => document.querySelectorAll(".proof-row").length === n, PAGES);
  await page.$eval(".proof-pages", (s) => (s.scrollTop = (s.scrollHeight - s.clientHeight) / 2));
  const place = () => page.$eval(".proof-pages", (s) => s.scrollTop / s.scrollHeight);
  const half = await place();
  await page.click(".modal-expand"); // back to the chosen size
  await page.waitForTimeout(100);
  near(await place() * 100, half * 100, 4);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("on a phone the window is already as big as the screen and has no handles", async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, storageState: await ctx.storageState() });
  const page = await phone.newPage();
  await openProof(page);
  expect(await page.isVisible(".modal-expand")).toBe(false);
  expect(await page.isVisible(".modal-grip[data-grip='e']")).toBe(false);
  await phone.close();
});
