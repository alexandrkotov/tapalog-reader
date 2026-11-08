import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let engine = "";

/** A PDF whose pages are nothing but pictures (JPEG), the way a scanned book is. */
function scanPdf(pictures: Uint8Array[], w: number, h: number): Uint8Array {
  const parts: (string | Uint8Array)[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (part: string | Uint8Array) => {
    parts.push(part);
    length += typeof part === "string" ? Buffer.byteLength(part, "latin1") : part.length;
  };
  const object = (n: number, body: string | (string | Uint8Array)[]) => {
    offsets[n] = length;
    add(`${n} 0 obj\n`);
    for (const piece of Array.isArray(body) ? body : [body]) add(piece);
    add("\nendobj\n");
  };
  add("%PDF-1.4\n");
  const pageIds = pictures.map((_, i) => 3 + i * 3);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pictures.length} >>`);
  pictures.forEach((jpeg, i) => {
    const page = 3 + i * 3;
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${page + 1} 0 R /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> >>`);
    object(page + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(page + 2, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
  });
  const size = 3 + pictures.length * 3;
  const xref = length;
  add(`xref\n0 ${size}\n0000000000 65535 f \n${Array.from({ length: size - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "latin1") : part;
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

before(async () => {
  browser = await launch();
  // the pictures of two pages: text in a big plain font, shot as a browser draws it
  const shot = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  const pictures: Uint8Array[] = [];
  for (const lines of [["Ламповый радиоприёмник", "для начинающих радиолюбителей"], ["Vacuum tube amplifier", "for the workshop of a beginner"]]) {
    await shot.setContent(`<body style="margin:0;background:#fff"><div style="font:46px serif;color:#000;padding:120px 60px;line-height:1.6">${lines.map((l) => `<p>${l}</p>`).join("")}</div></body>`);
    pictures.push(new Uint8Array(await shot.screenshot({ type: "jpeg", quality: 92 })));
  }
  await shot.close();
  inst = await startServer({ "Scans/scan.pdf": scanPdf(pictures, 1000, 1300) });
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
  expect(listed[0]).toMatchObject({ pages: null, done: 0 });
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

  // going on: the held page is not read again, the other is
  const second = await page.evaluate(async (bookId) => {
    const m = (await import("/__ocr.js" as string)) as { recognizeBook(o: object): Promise<unknown> };
    return m.recognizeBook({ id: bookId, lang: "rus+eng", lanes: 2 });
  }, id);
  expect(second).toMatchObject({ done: 2, pages: 2, failed: [], stopped: false });
  status = (await api<{ books: typeof status[] }>(ctx, inst, "/api/admin/ocr")).books[0]!;
  expect(status).toMatchObject({ pages: 2, done: 2 });
  const english = (await api<{ books: { hits: { loc: { page: number } }[] }[] }>(ctx, inst, "/api/fulltext?q=amplifier")).books;
  expect(english).toHaveLength(1);
  expect(english[0]!.hits[0]!.loc).toEqual({ page: 2 });
  expect(errors).toEqual([]);
  await page.close();
});
