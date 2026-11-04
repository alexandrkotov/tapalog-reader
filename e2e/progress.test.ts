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

const shown = (page: Page) => page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value);

async function open(context: BrowserContext, hash = `#book=${id}`): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/${hash}`);
  await page.waitForSelector(".pdf-scroll .page canvas");
  return { page, errors };
}

async function goTo(page: Page, n: number): Promise<void> {
  await page.fill(".pdf-page-input", String(n));
  await page.press(".pdf-page-input", "Enter");
  await page.waitForFunction((want) => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === String(want), n);
}

/** The place the server holds for the signed-in context, once it has the page `n` (it is sent a moment after the reader stops). */
async function savedPage(context: BrowserContext, n: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { progress } = await api<{ progress: { view: { page?: number } | null } | null }>(context, inst, `/api/progress/${id}`);
    if (progress?.view?.page === n) return;
    await Bun.sleep(250);
  }
  throw new Error(`the server never got page ${n}`);
}

e2e("a book opens where the reader left it, and the home page offers it under Continue reading", async () => {
  const first = await open(ctx);
  expect(await shown(first.page)).toBe("1");
  await goTo(first.page, 7);
  await savedPage(ctx, 7);
  await first.page.close();

  const again = await open(ctx); // the same address as before, no place in it
  expect(await shown(again.page)).toBe("7");
  expect(again.errors).toEqual([]);
  await again.page.close();

  const home = await ctx.newPage();
  await home.goto(inst.url + "/");
  await home.waitForSelector(".recent .card");
  expect(await home.textContent(".recent .recent-title")).toBe("Continue reading");
  expect(await home.textContent(".recent .card .name")).toBe("pages");
  expect(await home.textContent(".recent .card .place")).toBe("Page 7");
  await home.click(".recent .card");
  await home.waitForSelector(".pdf-scroll .page canvas");
  expect(await shown(home)).toBe("7");
  await home.close();
});

e2e("a link or bookmark that names a place wins over the saved one, and the saved one follows the reader there", async () => {
  const view = encodeURIComponent(JSON.stringify({ v: 1, page: 2 }));
  const linked = await open(ctx, `#book=${id}&view=${view}`);
  expect(await shown(linked.page)).toBe("2");
  await savedPage(ctx, 2);
  await linked.page.close();
  const next = await open(ctx);
  expect(await shown(next.page)).toBe("2");
  await next.page.close();
});

e2e("another account has its own places and sees none of this one's", async () => {
  const reg = await fetch(`${inst.url}/api/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify({ name: "Second", password: "pin1234" }) });
  expect(reg.ok).toBe(true);
  const other = await signedIn(browser, inst, { name: "Second", password: "pin1234" });
  const home = await other.newPage();
  await home.goto(inst.url + "/");
  await home.waitForSelector(".shelf");
  await home.waitForTimeout(500);
  expect(await home.$(".recent .card")).toBeNull();
  await home.close();
  const book = await open(other);
  expect(await shown(book.page)).toBe("1"); // not the other reader's page 2
  await other.close();
});

e2e("a guest's places stay in that browser, and a signed-in reader never gets them", async () => {
  const guest = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await guest.addInitScript(() => localStorage.setItem("tour", "1"));
  expect(((await (await guest.request.get(inst.url + "/api/me")).json()) as { canBrowse: boolean }).canBrowse).toBe(true);
  const first = await open(guest);
  await goTo(first.page, 5);
  await first.page.waitForTimeout(2200);
  await first.page.close();
  const again = await open(guest);
  expect(await shown(again.page)).toBe("5");
  await again.page.close();

  // the same address in an account's browser: the account's own place (page 2), not the guest's
  const mine = await open(ctx);
  expect(await shown(mine.page)).toBe("2");
  await mine.page.close();
  await guest.close();
});
