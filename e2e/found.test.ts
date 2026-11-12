import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { epub, pdf } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

const filler = "lorem ipsum dolor sit amet ".repeat(70);
before(async () => {
  browser = await launch();
  inst = await startServer({
    "Books/valves.txt": Array.from({ length: 30 }, (_, i) => `${filler}\n\nКаскад на пентоде номер ${i} и Pentode stage.`).join("\n\n"),
    "Docs/tubes.epub": epub("The Tubes"),
    "Docs/pages.pdf": pdf(3),
  });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  for (let i = 0; i < 120; i++) {
    const status = (await (await ctx.request.get(`${inst.url}/api/admin/fulltext`)).json()) as { total: number; indexed: number };
    if (status.total > 0 && status.indexed === status.total) return;
    await Bun.sleep(250);
  }
  throw new Error("the books were never indexed");
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

/** The words that are marked on the page now, as they stand in the text. */
const marked = (page: Page) =>
  page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("tapalog-found");
    return h ? [...h].map((r) => r.toString()) : [];
  });

e2e("a hit of the page of results opens the book with the words that were found marked in its text, and the first one in view", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#search=pentode`);
  await page.waitForSelector(".found-book");
  await page.click(".found-book:has-text('valves') .found-hit >> nth=0");
  expect(await page.evaluate(() => location.hash)).toMatch(/&find=/);
  await page.waitForSelector(".txt-body");
  await page.waitForFunction(() => ((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("tapalog-found")?.size ?? 0) > 0);
  const words = await marked(page);
  expect(words.length).toBeGreaterThan(0);
  expect(words.every((w) => w.toLowerCase() === "pentode")).toBe(true);
  // the first place is in the window, not left below it
  const inView = await page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("tapalog-found")!;
    const rects = [...h].map((r) => r.getBoundingClientRect()).filter((r) => r.height > 0 && r.top >= 0 && r.bottom <= innerHeight);
    return rects.length;
  });
  expect(inView).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a hit of the quick list under the search box marks the found words the same way, in a form the text has (not only the word typed)", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector("#search");
  await page.fill("#search", "пентод");
  await page.waitForSelector("#search-results li[data-index]");
  await page.click("#search-results li[data-index]:has-text('пентод')");
  await page.waitForSelector(".txt-body");
  await page.waitForFunction(() => ((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("tapalog-found")?.size ?? 0) > 0);
  const words = (await marked(page)).map((w) => w.toLowerCase());
  expect(words.length).toBeGreaterThan(0);
  expect(words.every((w) => w === "пентоде")).toBe(true); // the form that stands in the text, found by the stem
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a book opened without a search has nothing marked, and the marks go when the next book opens", async () => {
  const page = await ctx.newPage();
  await page.goto(`${inst.url}/#search=pentode`);
  await page.waitForSelector(".found-book");
  await page.click(".found-book:has-text('valves') .found-hit >> nth=0");
  await page.waitForFunction(() => ((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("tapalog-found")?.size ?? 0) > 0);
  await page.evaluate(() => (location.hash = "#folder=Docs"));
  await page.waitForFunction(() => !(CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.has("tapalog-found"));
  await page.goto(`${inst.url}/#folder=Books`);
  await page.waitForSelector(".card");
  await page.click(".card:has-text('valves')");
  await page.waitForSelector(".txt-body");
  expect(await marked(page)).toEqual([]);
  await page.close();
});

e2e("in a PDF the words are marked on the page of its text, and in a book of the text engine in the chapter that is opened", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#search=Page`);
  await page.waitForSelector(".found-book");
  await page.click(".found-book:has-text('pages') .found-hit >> nth=0");
  await page.waitForSelector(".textLayer span");
  await page.waitForFunction(() => ((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("tapalog-found")?.size ?? 0) > 0);
  expect((await marked(page)).every((w) => w.toLowerCase() === "page")).toBe(true);

  await page.goto(`${inst.url}/#search=lantern`);
  await page.waitForSelector(".found-book");
  await page.click(".found-book:has-text('Tubes') .found-hit >> nth=0");
  await page.waitForSelector("foliate-view");
  // the text engine draws what is marked as shapes over the chapter
  await page.waitForFunction(() => {
    const view = document.querySelector("foliate-view") as unknown as { renderer?: { getContents(): { overlayer?: { element: Element } }[] } } | null;
    return !!view?.renderer?.getContents().some((c) => (c.overlayer?.element.querySelectorAll("rect, path").length ?? 0) > 0);
  });
  expect(errors).toEqual([]);
  await page.close();
});
