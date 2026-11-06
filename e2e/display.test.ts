import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { library } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let id = "";

before(async () => {
  browser = await launch();
  inst = await startServer(library());
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  id = await bookId(ctx, inst, "Docs/pages.pdf");
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

async function open(context: BrowserContext, hash = `#book=${id}`): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/${hash}`);
  await page.waitForSelector(".pdf-scroll .page canvas");
  return { page, errors };
}

/** Whether the first page is shown upright (taller than wide) or on its side. */
const upright = (page: Page) =>
  page.evaluate(() => {
    const r = (document.querySelector(".pdf-scroll .page") as HTMLElement).getBoundingClientRect();
    return r.height > r.width;
  });
const waitUpright = (page: Page, want: boolean) => page.waitForFunction((w) => { const r = (document.querySelector(".pdf-scroll .page") as HTMLElement).getBoundingClientRect(); return r.height > r.width === w; }, want);
const turn = (page: Page) => page.click(".pdf-toolbar button[aria-label='Rotate']");
const hashView = (page: Page) => page.evaluate(() => JSON.parse(decodeURIComponent(location.hash).split("&view=")[1]!) as { page: number; region?: { x: number; y: number; w: number; h: number } });

const reset = () => ctx.request.put(`${inst.url}/api/display/${id}`, { data: { display: {} }, headers: { Origin: inst.url } }); // a test that failed halfway must not leave its turn to the next one

/** The page's box once it has stopped moving (a turned or refitted page settles a moment after the click). */
async function settledBox(page: Page, selector: string) {
  let last = "";
  for (let i = 0; i < 100; i++) {
    const box = await page.locator(selector).boundingBox();
    const key = JSON.stringify(box);
    if (box && key === last) return box;
    last = key;
    await page.waitForTimeout(250);
  }
  throw new Error("the page never settled");
}

async function stored(context: BrowserContext, want: unknown): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const { display } = await api<{ display: unknown }>(context, inst, `/api/display/${id}`);
    if (JSON.stringify(display) === JSON.stringify(want)) return;
    await Bun.sleep(250);
  }
  throw new Error("the server never held " + JSON.stringify(want));
}

e2e("pages are turned a quarter at a time, remembered per account, and four turns bring back the file's own look", async () => {
  await reset();
  const first = await open(ctx);
  expect(await upright(first.page)).toBe(true);
  await turn(first.page);
  await waitUpright(first.page, false);
  await stored(ctx, { rotation: 90 });
  await first.page.close();

  const again = await open(ctx); // no rotation in the address
  expect(await upright(again.page)).toBe(false);
  expect(again.errors).toEqual([]);
  await turn(again.page); // 180: upright again, upside down
  await waitUpright(again.page, true);
  await stored(ctx, { rotation: 180 });
  await turn(again.page);
  await turn(again.page);
  await waitUpright(again.page, true);
  await stored(ctx, null); // nothing left to remember
  await again.page.close();
});

e2e("a turned page keeps areas and positions in the page as the file has it", async () => {
  await reset();
  const { page, errors } = await open(ctx);
  await page.fill(".pdf-page-input", "3");
  await page.press(".pdf-page-input", "Enter");
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "3");
  await page.click(".pdf-toolbar button:has-text('Whole page')"); // the whole page in view, so every point of the drag is on it
  await page.click(".pdf-toolbar button:has-text('Area')");
  const box = await settledBox(page, ".pdf-scroll .page[data-page-number='3']");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector(".pdf-region:not(.pdf-region-draft)");
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes("region"));
  const size = () => page.evaluate(() => { const r = (document.querySelector(".pdf-region:not(.pdf-region-draft)") as HTMLElement).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  const before = await size();
  const area = (await hashView(page)).region!;

  await turn(page);
  await page.waitForFunction(() => { const r = (document.querySelector(".pdf-region:not(.pdf-region-draft)") as HTMLElement | null)?.getBoundingClientRect(); return !!r && r.height > r.width; });
  await settledBox(page, ".pdf-scroll .page[data-page-number='3']");
  const after = await size();
  // the rectangle turns with the page: its shape on screen is the other way round ...
  expect(after.w / after.h).toBeCloseTo(before.h / before.w, 1); // (the zoom changed with the width of the turned page, so compare shapes)
  // ... while the address, a bookmark or a link made now still names the same place of the page
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes("region"));
  const now = await hashView(page);
  expect(now.page).toBe(3);
  expect(now.region).toEqual(area);

  // drawing a new area on the turned page lands where it was drawn
  await page.click(".pdf-toolbar button:has-text('Area')");
  const turned = await settledBox(page, ".pdf-scroll .page[data-page-number='3']");
  await page.mouse.move(turned.x + turned.width * 0.1, turned.y + turned.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(turned.x + turned.width * 0.5, turned.y + turned.height * 0.2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((was) => JSON.stringify(JSON.parse(decodeURIComponent(location.hash).split("&view=")[1]!).region) !== was, JSON.stringify(area));
  const drawn = (await hashView(page)).region!;
  // Drawn on the screen as x 0.1..0.5, y 0.1..0.2 of the page turned a quarter clockwise. In the file's own page
  // (screen x = 1 - y, screen y = x) that is the tall strip x 0.1..0.2, y 1 - 0.5 .. 1 - 0.1.
  expect(drawn.w).toBeCloseTo(0.1, 1);
  expect(drawn.h).toBeCloseTo(0.4, 1);
  expect(drawn.x).toBeCloseTo(0.1, 1);
  expect(drawn.y).toBeCloseTo(0.5, 1);
  expect(errors).toEqual([]);
  await page.close();
  await ctx.request.put(`${inst.url}/api/display/${id}`, { data: { display: {} }, headers: { Origin: inst.url } });
});

e2e("another account has its own look, and a guest's stays in that browser", async () => {
  await reset();
  const turned = await open(ctx);
  await turn(turned.page);
  await waitUpright(turned.page, false);
  await stored(ctx, { rotation: 90 });
  await turned.page.close();

  const reg = await fetch(`${inst.url}/api/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify({ name: "Second", password: "pin1234" }) });
  expect(reg.ok).toBe(true);
  const other = await signedIn(browser, inst, { name: "Second", password: "pin1234" });
  const theirs = await open(other);
  expect(await upright(theirs.page)).toBe(true); // not the first account's turn
  await other.close();

  const guest = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await guest.addInitScript(() => localStorage.setItem("tour", "1"));
  const g = await open(guest);
  expect(await upright(g.page)).toBe(true);
  await turn(g.page);
  await waitUpright(g.page, false);
  await g.page.close();
  const again = await open(guest);
  expect(await upright(again.page)).toBe(false);
  await again.page.close();
  await guest.close();

  // the guest's turn never reached the server, and the account still has its own
  const mine = await open(ctx);
  expect(await upright(mine.page)).toBe(false);
  await mine.page.close();
});

/** Prints the page being read and says whether the picture that was prepared is wider than tall. */
async function printedShape(page: Page): Promise<"landscape" | "portrait"> {
  await page.evaluate(() => ((window as any).__printed = false));
  await page.click("button:has-text('Print')");
  await page.waitForSelector(".print-choices");
  await page.click("input[value=here]");
  await page.click(".modal .btn.primary");
  await page.waitForFunction(() => (window as any).__printed === true, null, { timeout: 60_000 });
  return page.evaluate(async () => {
    const img = document.getElementById("print-root")!.shadowRoot!.querySelector("img")!;
    await img.decode();
    return img.naturalWidth > img.naturalHeight ? "landscape" : "portrait";
  });
}

e2e("what is printed is turned the way the reader sees the book", async () => {
  await reset();
  const { page } = await open(ctx);
  await page.evaluate(() => ((window as any).print = () => ((window as any).__printed = true))); // the print window cannot be driven here
  expect(await printedShape(page)).toBe("portrait");
  await turn(page);
  await waitUpright(page, false);
  expect(await printedShape(page)).toBe("landscape");
  await page.close();
  await reset();
});

type R = { x: number; y: number; w: number; h: number };
const cropped = (crop: { all?: R; odd?: R; even?: R }) => ctx.request.put(`${inst.url}/api/display/${id}`, { data: { display: { crop } }, headers: { Origin: inst.url } });
/** An address that names the page, which always wins over the place saved by an earlier test. */
const at = (page: number) => `#book=${id}&view=${encodeURIComponent(JSON.stringify({ v: 1, page }))}`;
/** The shape of a page on screen: its height over its width. */
const aspectOf = (page: Page, n: number) => page.evaluate((p) => { const r = (document.querySelector(`.pdf-scroll .page[data-page-number='${p}']`) as HTMLElement).getBoundingClientRect(); return r.height / r.width; }, n);
/** Whether page `n`'s picture holds the fixture's red bar (it is at 0.13..0.22 across and 0.64..0.76 down the whole page). */
const hasRed = (page: Page, n: number) =>
  page.evaluate((p) => {
    const canvas = document.querySelector(`.pdf-scroll .page[data-page-number='${p}'] canvas`) as HTMLCanvasElement | null;
    if (!canvas || !canvas.width) return null;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) if (data[i]! > 150 && data[i + 1]! < 100 && data[i + 2]! < 100) return true;
    return false;
  }, n);
async function goTo(page: Page, n: number): Promise<void> {
  await page.fill(".pdf-page-input", String(n));
  await page.press(".pdf-page-input", "Enter");
  await page.waitForFunction((want) => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === String(want), n);
}

e2e("a cut shows only its part of each page, and odd and even pages can be cut apart", async () => {
  await reset();
  // odd pages: the lower half (the red bar is in it); even pages: the top quarter (it is not)
  expect((await cropped({ odd: { x: 0, y: 0.5, w: 1, h: 0.5 }, even: { x: 0, y: 0, w: 1, h: 0.25 } })).ok()).toBe(true);
  const { page, errors } = await open(ctx, at(1));
  const whole = 842 / 595;
  expect(Math.abs((await aspectOf(page, 1)) - whole * 0.5)).toBeLessThan(0.02);
  expect(Math.abs((await aspectOf(page, 2)) - whole * 0.25)).toBeLessThan(0.02);
  await page.waitForFunction((n) => {
    const c = document.querySelector(`.pdf-scroll .page[data-page-number='${n}'] canvas`) as HTMLCanvasElement | null;
    return !!c && c.width > 0;
  }, 1);
  let seen: boolean | null = null;
  for (let i = 0; i < 40 && seen !== true; i++) (seen = await hasRed(page, 1), seen !== true && (await page.waitForTimeout(250)));
  expect(seen).toBe(true); // the cut kept the bar ...
  await goTo(page, 2);
  await page.waitForSelector(".pdf-scroll .page[data-page-number='2'] canvas");
  await page.waitForTimeout(1000);
  expect(await hasRed(page, 2)).toBe(false); // ... and the other cut left it out
  expect(errors).toEqual([]);
  await page.close();
  await reset();
});

e2e("on a cut page, areas, positions and links keep to the whole page as the file has it", async () => {
  await reset();
  expect((await cropped({ all: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } })).ok()).toBe(true);
  const { page, errors } = await open(ctx, at(3));
  await page.click(".pdf-toolbar button:has-text('Whole page')");
  await page.click(".pdf-toolbar button:has-text('Area')");
  const box = await settledBox(page, ".pdf-scroll .page[data-page-number='3']");
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.2, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector(".pdf-region:not(.pdf-region-draft)");
  await page.waitForFunction(() => decodeURIComponent(location.hash).includes("region"));
  const area = (await hashView(page)).region!;
  // 0.1..0.5 across and 0.1..0.2 down the cut = 0.2 + 0.6 * that, in the whole page
  expect(area.x).toBeCloseTo(0.26, 1);
  expect(area.w).toBeCloseTo(0.24, 1);
  expect(area.y).toBeCloseTo(0.26, 1);
  expect(area.h).toBeCloseTo(0.06, 1);

  // the same address (what a link or a bookmark holds) shows the same area in the same place of the cut
  const before = await page.evaluate(() => { const p = document.querySelector(".pdf-scroll .page[data-page-number='3']")!.getBoundingClientRect(); const r = document.querySelector(".pdf-region:not(.pdf-region-draft)")!.getBoundingClientRect(); return { x: (r.left - p.left) / p.width, y: (r.top - p.top) / p.height, w: r.width / p.width }; });
  await page.reload();
  await page.waitForSelector(".pdf-region:not(.pdf-region-draft)");
  const afterBox = await settledBox(page, ".pdf-scroll .page[data-page-number='3']");
  const after = await page.evaluate(() => { const p = document.querySelector(".pdf-scroll .page[data-page-number='3']")!.getBoundingClientRect(); const r = document.querySelector(".pdf-region:not(.pdf-region-draft)")!.getBoundingClientRect(); return { x: (r.left - p.left) / p.width, y: (r.top - p.top) / p.height, w: r.width / p.width }; });
  expect(afterBox.width).toBeGreaterThan(0);
  expect(after.x).toBeCloseTo(before.x, 1);
  expect(after.y).toBeCloseTo(before.y, 1);
  expect(after.w).toBeCloseTo(before.w, 1);
  expect((await hashView(page)).region).toEqual(area);
  expect(errors).toEqual([]);
  await page.close();
  await reset();
});

e2e("what is printed is cut the way the reader sees the book", async () => {
  await reset();
  expect((await cropped({ all: { x: 0, y: 0, w: 1, h: 0.4 } })).ok()).toBe(true); // a wide strip of a tall page
  const { page } = await open(ctx, at(1));
  await page.evaluate(() => ((window as any).print = () => ((window as any).__printed = true)));
  expect(await printedShape(page)).toBe("landscape");
  await page.close();
  await reset();
});
