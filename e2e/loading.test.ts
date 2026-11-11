import { expect } from "bun:test";
import { zipSync } from "fflate";
import type { Browser, BrowserContext } from "playwright-core";
import { library, notes, png } from "./fixtures";
import { after, api, before, bookId, e2e, FOLIATE_RACE, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

/** A comic of 12 pages that is much bigger than its pages: after each picture comes a block of bytes that only makes the file long (1.2 MB), so a page is a piece of its own. */
const bigComic = (): Uint8Array => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, "0");
    files[`page${n}.png`] = png(60, 90, [(i * 20) % 256, 90, 200 - i * 10]);
    files[`pad${n}.bin`] = new Uint8Array(1_200_000).map((_, k) => (k * 7919 + i) % 251);
  }
  return zipSync(files, { level: 0 });
};
/** A text of about 2 MB. */
const bigText = (): string => {
  const phrase = notes();
  return Array.from({ length: Math.ceil((2 * 1024 * 1024) / phrase.length) }, () => phrase).join("\n\n");
};

before(async () => {
  browser = await launch();
  inst = await startServer({ ...library(), "Comics/big.cbz": bigComic(), "Docs/big.txt": bigText() });
  await setup(inst);
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

/** Makes the book's file come slowly, in small pieces, as it does over a phone and a tunnel; a request by stretch waits `wait` ms. */
const slowLine = (page: import("playwright-core").Page, opts: { chunk?: number; every?: number; wait?: number }) =>
  page.addInitScript((o) => {
    const real = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (!/\/api\/(file|share)\//.test(url) || !/\/file$|\/api\/file\//.test(url)) return real(input, init);
      const ranged = !!(init?.headers as Record<string, string> | undefined)?.Range;
      if (ranged) {
        await new Promise((r) => setTimeout(r, o.wait ?? 0));
        return real(input, init);
      }
      const res = await real(input, init);
      const reader = res.body!.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          for (let at = 0; at < value.length; at += o.chunk ?? 65536) {
            controller.enqueue(value.subarray(at, at + (o.chunk ?? 65536)));
            await new Promise((r) => setTimeout(r, o.every ?? 80));
          }
        },
      });
      return new Response(stream, { status: res.status, headers: res.headers });
    }) as typeof window.fetch;
  }, opts);

e2e("a book on a slow line shows a bar with the megabytes that have come and the size of the file, then goes away when the text is there", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await slowLine(page, { chunk: 131072, every: 90 });
  await page.goto(`${inst.url}/#book=${await bookId(ctx, inst, "Docs/big.txt")}`);
  const seen: { text: string; width: number }[] = [];
  const loaded = () => page.evaluate(() => (document.querySelector(".txt-body")?.textContent ?? "").includes("Тихая гавань"));
  while (!(await loaded())) {
    const state = await page.evaluate(() => {
      const bar = document.querySelector(".reader-loading");
      const fill = document.querySelector(".loading-fill") as HTMLElement | null;
      return bar && !(bar as HTMLElement).hidden ? { text: document.querySelector(".loading-text")?.textContent ?? "", width: parseFloat(fill?.style.width || "0") } : null;
    });
    if (state) seen.push(state);
    await page.waitForTimeout(100);
  }
  const counted = seen.filter((s) => /^Loading: \d+(\.\d)? (KB|MB) of \d+\.\d MB \(\d+%\)$/.test(s.text));
  expect(counted.length).toBeGreaterThan(3);
  const widths = counted.map((s) => s.width);
  expect(widths[0]).toBeLessThan(widths.at(-1)!);
  expect([...widths].sort((a, b) => a - b)).toEqual(widths); // it only grows
  expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  await page.waitForFunction(() => !document.querySelector(".reader-loading"));
  expect(await page.textContent(".txt-body")).toContain("Тихая гавань");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a book that opens at once is never covered by a flash of the bar, and no bar is left over in any reader", async () => {
  for (const path of ["Docs/notes.txt", "Docs/pages.pdf", "Books/story.epub", "Books/tale.fb2", "Comics/strip.cbz"]) {
    const page = await ctx.newPage();
    const errors = watchErrors(page, FOLIATE_RACE);
    await page.addInitScript(() => {
      (window as unknown as { shown: number }).shown = 0;
      new MutationObserver(() => {
        const bar = document.querySelector(".reader-loading");
        if (bar && !(bar as HTMLElement).hidden) (window as unknown as { shown: number }).shown++;
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await page.goto(`${inst.url}/#book=${await bookId(ctx, inst, path)}`);
    await page.waitForSelector(".reader-bar");
    await page.waitForSelector(path.endsWith(".pdf") ? ".pdf-scroll .page canvas" : path.endsWith(".txt") ? ".txt-body" : "foliate-view");
    await page.waitForTimeout(500);
    expect(await page.$(".reader-loading")).toBeNull();
    expect(await page.$(".reader-busy:not([hidden])")).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { shown: number }).shown)).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }
});

e2e("a big comic on a share link opens by asking for stretches of the file, not for all of it, and tells it is loading while the line is slow", async () => {
  const id = await bookId(ctx, inst, "Comics/big.cbz");
  const made = await api<{ token: string }>(ctx, inst, "/api/shares", { bookId: id, view: null, expiresInDays: 1 });
  const stranger = await browser.newContext();
  const page = await stranger.newPage();
  const errors = watchErrors(page, FOLIATE_RACE);
  await slowLine(page, { wait: 700 });
  const replies: { status: number; range: string | undefined; length: number }[] = [];
  page.on("response", (res) => {
    if (res.url().endsWith(`/api/share/${made.token}/file`)) void res.body().then((b) => replies.push({ status: res.status(), range: res.headers()["content-range"], length: b.length }), () => {});
  });
  await page.goto(`${inst.url}/s/${made.token}`);
  await page.waitForSelector(".reader-loading:not([hidden])"); // asked for more than 300 ms ago and still not here
  expect(await page.textContent(".loading-text")).toMatch(/^(Loading the book…|Loaded: \d+(\.\d)? (KB|MB)|Opening the book…)$/);
  await page.waitForSelector("foliate-view");
  await page.waitForFunction(() => /%/.test(document.querySelector(".book-progress")?.textContent ?? ""));
  await page.waitForFunction(() => !document.querySelector(".reader-loading"));
  expect(replies.length).toBeGreaterThan(0);
  expect(replies.every((r) => r.status === 206 && !!r.range)).toBe(true); // never the whole file
  const total = Number(/\/(\d+)$/.exec(replies[0]!.range!)![1]);
  expect(total).toBeGreaterThan(8 * 1024 * 1024);
  expect(replies.reduce((n, r) => n + r.length, 0)).toBeLessThan(total / 2);
  expect(errors).toEqual([]);
  await stranger.close();
});

e2e("turning the pages of a comic read in stretches shows every page, and a page that is slow says so at the foot", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page, FOLIATE_RACE);
  await slowLine(page, { wait: 1200 });
  await page.goto(`${inst.url}/#book=${await bookId(ctx, inst, "Comics/big.cbz")}`);
  await page.waitForSelector("foliate-view");
  await page.waitForFunction(() => /%/.test(document.querySelector(".book-progress")?.textContent ?? ""), undefined, { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector(".reader-loading"));
  await page.click("button[title='Page previews']");
  await page.waitForSelector(".thumbs");
  expect(await page.$$eval(".thumb-cell", (c) => c.length)).toBe(12); // the list of pages is whole though only the end of the file was read
  await page.click(".thumb-cell[data-n='12']");
  await page.waitForFunction(() => document.querySelector(".thumb-cell.current")?.getAttribute("data-n") === "12");
  await page.waitForFunction(() => {
    const note = document.querySelector(".reader-busy") as HTMLElement | null;
    return !!note && !note.hidden && /^Loading the page… \d+(\.\d)? (KB|MB)$/.test(note.textContent ?? "");
  });
  await page.waitForFunction(() => (document.querySelector(".reader-busy") as HTMLElement).hidden, undefined, { timeout: 30_000 }); // and goes away when the pieces are here
  expect(errors).toEqual([]);
  await page.close();
});
