import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { scanPdf, scanPictures, PAGE_W, PAGE_H } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let engine = "";

before(async () => {
  browser = await launch();
  const pictures = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"], ["Vacuum tube amplifier", "for the workshop of a beginner"]]);
  inst = await startServer({ "Scans/scan.pdf": scanPdf(pictures, PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  // the same code the page runs, bundled for this test (the page itself has no way to be called from outside)
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/web/ocrEngine.ts`], target: "browser", format: "esm" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  engine = await built.outputs[0]!.text();
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("a scanned PDF is read page by page in the browser, the text goes to the server, and search finds it by page; a second run goes on from what is held", async () => {
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  let listed: { id: string; pages: number | null; done: number }[] = [];
  for (let i = 0; i < 120 && !listed.length; i++) {
    await Bun.sleep(250);
    listed = (await api<{ books: typeof listed }>(ctx, inst, "/api/admin/ocr")).books;
  }
  expect(listed).toHaveLength(1); // the indexer found a PDF with no text and offers it
  expect(listed[0]).toMatchObject({ pages: 2, textPages: 0, done: 0 }); // the index counted the pages before any was read
  const id = await bookId(ctx, inst, "Scans/scan.pdf");

  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${inst.url}/__ocr.js`, (route) => route.fulfill({ contentType: "text/javascript", body: engine }));
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });

  const first = await page.evaluate(async (bookId) => {
    const m = (await import("/__ocr.js" as string)) as { recognizeBook(o: object): Promise<unknown>; ocrSupported(): boolean };
    const progress: { done: number; pages: number }[] = [];
    const states: string[] = [];
    const stop = new AbortController();
    // stop after the first page has gone to the server: one page is read, the other is left for the next run
    const outcome = await m.recognizeBook({
      id: bookId,
      lang: "rus+eng",
      lanes: 1,
      signal: stop.signal,
      onState: (s: string) => states.push(s),
      onProgress: (p: { done: number; pages: number }) => {
        progress.push({ done: p.done, pages: p.pages });
        if (p.done >= 1) stop.abort();
      },
    });
    return { outcome, progress, states, supported: m.ocrSupported() };
  }, id);
  expect(first.supported).toBe(true);
  expect(first.states).toEqual(["loading", "reading"]);
  expect(first.outcome).toMatchObject({ done: 1, pages: 2, failed: [], stopped: true });
  expect(first.progress.at(-1)).toEqual({ done: 1, pages: 2 });

  let status = (await api<{ books: { id: string; pages: number; done: number; lang: string }[] }>(ctx, inst, "/api/admin/ocr")).books[0]!;
  expect(status).toMatchObject({ pages: 2, done: 1, lang: "rus+eng" });
  const firstHit = (await api<{ books: { hits: { loc: { page: number } }[] }[] }>(ctx, inst, "/api/fulltext?q=" + encodeURIComponent("радиоприёмник"))).books;
  expect(firstHit).toHaveLength(1);
  expect(firstHit[0]!.hits[0]!.loc).toEqual({ page: 1 });

  // the words of the page come with its text, with their frames as parts of the page, in reading order
  const frames = async (n: number) => (await api<{ boxes: [string, number, number, number, number][] }>(ctx, inst, `/api/ocr/${id}/boxes/${n}`)).boxes;
  const one = await frames(1);
  expect(one.map((b) => b[0]).join(" ").toLowerCase().replace(/ё/g, "е")).toContain("радиоприемник");
  expect(one[0]![0].toLowerCase()).toContain("лампов"); // the first word of the first line comes first
  for (const [, x0, y0, x1, y1] of one) {
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThanOrEqual(1);
    expect(y1).toBeLessThanOrEqual(1);
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
  }
  expect((await ctx.request.get(`${inst.url}/api/ocr/${id}/boxes/2`)).status()).toBe(404); // not read yet

  // going on: the held page is not read again, the other is
  const second = await page.evaluate(async (bookId) => {
    const m = (await import("/__ocr.js" as string)) as { recognizeBook(o: object): Promise<unknown> };
    return m.recognizeBook({ id: bookId, lang: "rus+eng", lanes: 2 });
  }, id);
  expect(second).toMatchObject({ done: 2, pages: 2, failed: [], stopped: false });
  status = (await api<{ books: typeof status[] }>(ctx, inst, "/api/admin/ocr")).books[0]!;
  expect(status).toMatchObject({ pages: 2, done: 2 });
  expect((await frames(2)).map((b) => b[0]).join(" ").toLowerCase()).toContain("amplifier");
  const english = (await api<{ books: { hits: { loc: { page: number } }[] }[] }>(ctx, inst, "/api/fulltext?q=amplifier")).books;
  expect(english).toHaveLength(1);
  expect(english[0]!.hits[0]!.loc).toEqual({ page: 2 });
  expect(errors).toEqual([]);
  await page.close();
});
