import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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

// ---------- the crop editor ----------

const tools = ".pdf-croptools";
const enterCrop = async (page: Page) => {
  await page.click(".pdf-toolbar button:has-text('Crop')");
  await page.waitForSelector(".pdf-crop-handle.h-e");
};
/** Presses an arrow key `times` times (with Shift: 5 % a time) on a focused edge handle of the frame. */
async function nudge(page: Page, edge: "n" | "e" | "s" | "w", key: string, times: number, shift = true) {
  await page.focus(`.pdf-crop-handle.h-${edge}`);
  for (let i = 0; i < times; i++) await page.keyboard.press(shift ? `Shift+${key}` : key);
}
const serverCrop = async (): Promise<any> => ((await api<{ display: { crop?: unknown } | null }>(ctx, inst, `/api/display/${id}`)).display ?? {}).crop ?? null;
async function savedCrop(want: (crop: any) => boolean): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const crop = await serverCrop();
    if (want(crop)) return crop;
    await Bun.sleep(250);
  }
  throw new Error("the server never held the crop that was expected: " + JSON.stringify(await serverCrop()));
}
const near = (a: number, b: number, digits = 2) => expect(a).toBeCloseTo(b, digits);

e2e("the crop editor: edges move with the keyboard, Preview shows the result, Apply keeps it, and it survives reopening", async () => {
  await reset();
  const { page, errors } = await open(ctx, at(1));
  const whole = 842 / 595;
  expect(await page.isHidden(tools)).toBe(true);
  await enterCrop(page);
  expect(await page.isVisible(tools)).toBe(true);
  near(await aspectOf(page, 1), whole); // the page is shown whole to cut from

  await nudge(page, "e", "ArrowLeft", 2); // the right edge 10 % in
  await nudge(page, "s", "ArrowUp", 6); // the bottom edge 30 % up
  near(await aspectOf(page, 1), whole); // still whole while editing
  await page.click(`${tools} button:has-text('Preview')`);
  await page.waitForFunction((want) => { const r = (document.querySelector(".pdf-scroll .page[data-page-number='1']") as HTMLElement).getBoundingClientRect(); return Math.abs(r.height / r.width - want) < 0.02; }, (0.7 * 842) / (0.9 * 595));
  expect(await page.$(".pdf-crop-handle")).toBeNull(); // no frame while previewing
  await page.click(`${tools} button:has-text('Preview')`);
  await page.waitForSelector(".pdf-crop-handle.h-e");
  near(await aspectOf(page, 1), whole);

  await page.click(`${tools} button:has-text('Apply')`);
  expect(await page.isHidden(tools)).toBe(true);
  await page.waitForFunction((want) => { const r = (document.querySelector(".pdf-scroll .page[data-page-number='1']") as HTMLElement).getBoundingClientRect(); return Math.abs(r.height / r.width - want) < 0.02; }, (0.7 * 842) / (0.9 * 595));
  const kept = await savedCrop((c) => !!c?.all);
  expect(Object.keys(kept)).toEqual(["all"]);
  near(kept.all.x, 0);
  near(kept.all.y, 0);
  near(kept.all.w, 0.9);
  near(kept.all.h, 0.7);
  await page.close();

  const again = await open(ctx, at(1)); // the next visit opens it cut
  near(await aspectOf(again.page, 1), (0.7 * 842) / (0.9 * 595));
  expect(errors).toEqual([]);
  expect(again.errors).toEqual([]);
  await again.page.close();
  await reset();
});

e2e("the crop editor: dragging the frame with the pointer, Cancel and Esc change nothing, Reset brings back the file's own look", async () => {
  await reset();
  const { page } = await open(ctx, at(1));
  const whole = 842 / 595;
  await enterCrop(page);
  const grab = async (handle: string, dx: number, dy: number) => {
    const b = (await page.locator(`.pdf-crop-handle.h-${handle}`).boundingBox())!;
    const page1 = (await page.locator(".pdf-scroll .page[data-page-number='1']").boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx * page1.width, b.y + b.height / 2 + dy * page1.height, { steps: 6 });
    await page.mouse.up();
  };
  await page.click(".pdf-toolbar button:has-text('Whole page')"); // all of the page in view, so the drags stay on screen
  await settledBox(page, ".pdf-scroll .page[data-page-number='1']");
  await grab("se", -0.2, -0.4); // the bottom-right corner in by 20 % across and 40 % up
  await page.click(`${tools} button:has-text('Apply')`);
  const kept = await savedCrop((c) => !!c?.all);
  near(kept.all.w, 0.8, 1);
  near(kept.all.h, 0.6, 1);

  // Cancel: leaves what was kept as it was, and the reader's zoom as it was
  await page.click(".pdf-toolbar button:has-text('Fit width')");
  const zoom = () => page.evaluate(() => document.querySelector(".pdf-zoom")!.textContent);
  await page.waitForTimeout(500);
  const before = await zoom();
  await enterCrop(page);
  await page.waitForFunction((was) => document.querySelector(".pdf-zoom")!.textContent !== was, before); // the whole page is fitted into the window to cut from it
  await nudge(page, "w", "ArrowRight", 4);
  await page.click(`${tools} button:has-text('Cancel')`);
  expect(await page.isHidden(tools)).toBe(true);
  await page.waitForFunction((was) => document.querySelector(".pdf-zoom")!.textContent === was, before);
  near(await aspectOf(page, 1), (0.6 * 842) / (0.8 * 595), 1);
  near((await serverCrop()).all.x, 0);

  // Esc does the same, and a second Esc is not taken for anything else
  await enterCrop(page);
  await nudge(page, "n", "ArrowDown", 4);
  await page.keyboard.press("Escape");
  expect(await page.isHidden(tools)).toBe(true);
  near((await serverCrop()).all.y, 0);

  // Reset: the whole page again, and nothing kept
  await enterCrop(page);
  await page.click(`${tools} button:has-text('Reset')`);
  expect(await page.isHidden(tools)).toBe(true);
  await page.waitForFunction((want) => { const r = (document.querySelector(".pdf-scroll .page[data-page-number='1']") as HTMLElement).getBoundingClientRect(); return Math.abs(r.height / r.width - want) < 0.02; }, whole);
  await savedCrop((c) => c === null);
  await page.close();
});

e2e("the crop editor: odd and even pages are cut apart, and a crop for the whole book replaces them", async () => {
  await reset();
  const { page } = await open(ctx, at(1));
  const whole = 842 / 595;
  await enterCrop(page);
  await page.click(`${tools} button[data-scope=odd]`);
  await nudge(page, "s", "ArrowUp", 4); // odd pages: bottom 20 % off
  await page.click(`${tools} button:has-text('Apply')`);
  await savedCrop((c) => !!c?.odd);

  await goTo(page, 2);
  await enterCrop(page);
  expect(await page.evaluate(() => document.querySelector(".pdf-crop-layer")!.classList.contains("off"))).toBe(false); // page 2 is where the even crop goes
  await page.click(`${tools} button[data-scope=even]`);
  await nudge(page, "n", "ArrowDown", 6); // even pages: top 30 % off
  await page.click(`${tools} button:has-text('Apply')`);
  const apart = await savedCrop((c) => !!c?.odd && !!c?.even);
  near(apart.odd.h, 0.8);
  near(apart.even.y, 0.3);
  near(apart.even.h, 0.7);
  await page.waitForFunction(([a, b]) => { const h = (n: number) => { const r = (document.querySelector(`.pdf-scroll .page[data-page-number='${n}']`) as HTMLElement).getBoundingClientRect(); return r.height / r.width; }; return Math.abs(h(1) - a!) < 0.02 && Math.abs(h(2) - b!) < 0.02; }, [0.8 * whole, 0.7 * whole] as const);

  // the frame on a page the edit is not for is shown dimmed and cannot be grabbed
  await enterCrop(page);
  expect(await page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value)).toBe("2"); // the place being read is kept when the mode opens
  await page.click(`${tools} button[data-scope=odd]`);
  expect(await page.evaluate(() => document.querySelector(".pdf-crop-layer")!.classList.contains("off"))).toBe(true); // reading page 2, an even one
  await page.keyboard.press("Escape");

  // a crop for the whole book replaces both
  await enterCrop(page);
  await nudge(page, "e", "ArrowLeft", 2);
  await page.click(`${tools} button:has-text('Apply')`);
  const all = await savedCrop((c) => !!c?.all);
  expect(Object.keys(all)).toEqual(["all"]);
  near(all.all.w, 0.9);
  await page.close();
  await reset();
});

e2e("the crop editor works on turned pages: the frame follows the screen, the crop stays in the page as the file has it", async () => {
  await reset();
  const { page } = await open(ctx, at(1));
  await turn(page); // a quarter clockwise: the page's top edge is now the screen's right edge
  await waitUpright(page, false);
  await enterCrop(page);
  await nudge(page, "e", "ArrowLeft", 2); // the screen's right edge, 10 % in
  await page.click(`${tools} button:has-text('Apply')`);
  const kept = await savedCrop((c) => !!c?.all);
  near(kept.all.x, 0);
  near(kept.all.w, 1);
  near(kept.all.y, 0.1); // ... which is the top of the page as the file has it
  near(kept.all.h, 0.9);
  await page.close();
  await reset();
});

// ---------- printed page numbers ----------

const printed = (page: Page) => page.evaluate(() => (document.querySelector(".pdf-printed-input") as HTMLInputElement).value);
const fileShown = (page: Page) => page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value);
const serverDisplay = async (): Promise<any> => (await api<{ display: unknown }>(ctx, inst, `/api/display/${id}`)).display;

e2e("printed page numbers: tell which number a page has, read and jump by printed numbers, and it is kept", async () => {
  await reset();
  const { page, errors } = await open(ctx, at(5));
  expect(await page.isHidden(".pdf-printed-input")).toBe(true); // no offset: only the file's numbers
  await page.click(".pdf-toolbar button:has-text('№')");
  await page.waitForSelector(".modal input[type=number]");
  await page.fill(".modal input[type=number]", "1"); // file page 5 is printed page 1
  await page.click(".modal .btn.primary");
  await page.waitForFunction(() => !document.querySelector(".modal"));
  expect(await page.isVisible(".pdf-printed-input")).toBe(true);
  expect(await printed(page)).toBe("1");
  expect(await fileShown(page)).toBe("5");

  await goTo(page, 9);
  await page.waitForFunction(() => (document.querySelector(".pdf-printed-input") as HTMLInputElement).value === "5");
  await goTo(page, 3); // front matter: it has no printed number
  await page.waitForFunction(() => (document.querySelector(".pdf-printed-input") as HTMLInputElement).value === "");

  // typing a printed number goes to that page of the file
  await page.fill(".pdf-printed-input", "4");
  await page.press(".pdf-printed-input", "Enter");
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "8");
  expect(await printed(page)).toBe("4");

  // a bookmark here is named by the printed page, and the saved place says the same
  await page.click(".reader-bar button:has-text('★')");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector(".modal .bookmark-go");
  expect(await page.textContent(".modal .bookmark-go")).toContain("4");
  expect(await page.textContent(".modal .bookmark-go")).not.toContain("8");
  await page.keyboard.press("Escape");

  const kept = await serverDisplay();
  expect(kept.pageOffset).toBe(4);
  await page.close();

  const again = await open(ctx, at(7)); // the next visit has it already
  await again.page.waitForFunction(() => (document.querySelector(".pdf-printed-input") as HTMLInputElement).value === "3");

  // the file's own numbers again
  await again.page.click(".pdf-toolbar button:has-text('№')");
  await again.page.click(".modal button:has-text(\"Use the file's numbers\")");
  await again.page.waitForFunction(() => !document.querySelector(".modal"));
  expect(await again.page.isHidden(".pdf-printed-input")).toBe(true);
  for (let i = 0; i < 40 && (await serverDisplay()) !== null; i++) await Bun.sleep(250);
  expect(await serverDisplay()).toBeNull();
  expect(errors).toEqual([]);
  await again.page.close();
  await reset();
});

e2e("turning, cropping and numbering never change the file", async () => {
  await reset();
  const file = `${inst.lib}/Docs/pages.pdf`;
  const fingerprint = () => `${createHash("sha256").update(readFileSync(file)).digest("hex")} ${statSync(file).mtimeMs}`;
  const before = fingerprint();
  const { page } = await open(ctx, at(2));
  await turn(page);
  await waitUpright(page, false);
  await enterCrop(page);
  await nudge(page, "e", "ArrowLeft", 2);
  await page.click(`${tools} button:has-text('Apply')`);
  await savedCrop((c) => !!c?.all);
  await page.click(".pdf-toolbar button:has-text('№')");
  await page.fill(".modal input[type=number]", "1");
  await page.click(".modal .btn.primary");
  for (let i = 0; i < 40 && !(await serverDisplay())?.pageOffset; i++) await Bun.sleep(250);
  expect((await serverDisplay()).rotation).toBe(90);
  expect((await serverDisplay()).pageOffset).toBe(1);
  await page.close();
  expect(fingerprint()).toBe(before); // the same bytes, and not even touched
  await reset();
});
