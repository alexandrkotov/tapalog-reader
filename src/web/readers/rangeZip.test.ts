import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { openComic, RangeCache, zipLoader } from "./rangeZip";

/** A comic of `n` pages, each of `size` bytes whose value is the page number, stored (not packed) like the pictures of a real one. */
function comic(n: number, size: number): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (let i = 1; i <= n; i++) files[`p${String(i).padStart(3, "0")}.png`] = new Uint8Array(size).fill(i);
  return zipSync(files, { level: 0 });
}

/** A fetch that answers from `bytes` the way the server does: by stretch (206) when asked for one, or the whole file when `ranges` is off. */
function serve(bytes: Uint8Array, opts: { ranges?: boolean } = {}) {
  const asked: string[] = [];
  const fake = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const range = new Headers(init?.headers).get("range");
    asked.push(range ?? "whole");
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || opts.ranges === false) return new Response(bytes as BodyInit, { headers: { "Content-Length": String(bytes.length) } });
    const size = bytes.length;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return new Response(bytes.slice(start, end + 1) as BodyInit, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${size}` } });
  };
  return { asked, fake: fake as typeof fetch };
}

const hooks = () => {
  const progress: { loaded: number; total: number | null }[] = [];
  const busy: [number, number][] = [];
  return { progress, busy, hooks: { onProgress: (p: { loaded: number; total: number | null }) => progress.push(p), onBusy: (n: number, b: number) => busy.push([n, b]) } };
};

test("a comic is opened and a page read by asking for stretches of the file, never the whole of it", async () => {
  const file = comic(40, 300_000); // about 12 MB
  const { asked, fake } = serve(file);
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    const h = hooks();
    const opened = await openComic("/file", "book.cbz", h.hooks);
    expect(opened.file).toBeNull();
    const book = opened.book as { sections: { id: string; size: number }[]; getCover(): Promise<Blob> };
    expect(book.sections).toHaveLength(40);
    expect(book.sections[0]!.id).toBe("p001.png");
    expect(book.sections[0]!.size).toBe(300_000);
    const cover = new Uint8Array(await (await book.getCover()).arrayBuffer());
    expect(cover).toHaveLength(300_000);
    expect(cover.every((b) => b === 1)).toBe(true);
    // the first answer carried the end of the file (the list of pages): the page cost a few requests, not a request for each 64 KB
    const bytesAsked = asked.map((r) => r.match(/^bytes=(\d*)-(\d*)$/)!).map((m) => (m[1] ? Number(m[2]) - Number(m[1]) + 1 : Number(m[2])));
    expect(asked.length).toBeLessThanOrEqual(3);
    expect(bytesAsked.reduce((a, b) => a + b, 0)).toBeLessThan(file.length / 2);
    expect(h.progress.at(-1)!.loaded).toBeGreaterThan(0);
    opened.dispose();
  } finally {
    globalThis.fetch = original;
  }
});

test("any page comes out whole and right, from the middle and from the end, in any order, each costing its own stretch", async () => {
  const file = comic(40, 300_000);
  const asked: [number, number][] = [];
  const cache = new RangeCache(file.length, async (start, end) => (asked.push([start, end]), file.slice(start, end)));
  cache.seed(file.length - 1_048_576, file.slice(file.length - 1_048_576));
  const loader = await zipLoader(cache);
  expect(loader.entries).toHaveLength(40);
  expect(asked).toHaveLength(0); // the list of pages was in the end of the file that came with the first answer
  for (const n of [7, 40, 1, 23, 7]) {
    const blob = await loader.loadBlob(`p${String(n).padStart(3, "0")}.png`, "image/png")!;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes).toHaveLength(300_000);
    expect(bytes.every((b) => b === n)).toBe(true);
  }
  expect(await loader.loadBlob("nothing.png")).toBeNull();
  // four distinct pages of about 300 KB: a request or two each, never one for every 64 KB step
  expect(asked.length).toBeLessThanOrEqual(9);
});

test("a server that sends the whole file for a request by stretch has the file read to the end, with the bytes counted", async () => {
  const file = comic(3, 50_000);
  const { fake } = serve(file, { ranges: false });
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    const h = hooks();
    const opened = await openComic("/file", "book.cbz", h.hooks);
    expect(opened.book).toBeNull();
    expect(opened.file!.size).toBe(file.length);
    expect(opened.file!.name).toBe("book.cbz");
    expect(h.progress.at(-1)).toEqual({ loaded: file.length, total: file.length });
  } finally {
    globalThis.fetch = original;
  }
});

test("pieces are asked for once: reading a page in small steps is one request, a piece already on its way is waited for", async () => {
  const data = new Uint8Array(10_000).map((_, i) => i % 251);
  const calls: [number, number][] = [];
  const cache = new RangeCache(
    data.length,
    async (start, end) => {
      calls.push([start, end]);
      await new Promise((r) => setTimeout(r, 5));
      return data.slice(start, end);
    },
    () => {},
    4000,
  );
  const steps = await Promise.all([cache.read(0, 100), cache.read(100, 100), cache.read(150, 50)]);
  expect(calls).toEqual([[0, 4000]]); // the second and third wait for the first
  expect(steps[1]![0]).toBe(100 % 251);
  expect(steps[2]).toHaveLength(50);
  await cache.read(3900, 200); // runs over the end of the piece: the next one is asked for from where it is needed
  expect(calls).toEqual([[0, 4000], [3900, 7900]]);
  expect([...(await cache.read(9990, 100))]).toEqual([...data.slice(9990)]); // the end of the file is cut to its size
  expect(await cache.read(20_000, 10)).toHaveLength(0);
});

test("the cache tells how many requests are in flight and how many bytes came since the wait began, and forgets the oldest pieces", async () => {
  const data = new Uint8Array(100_000);
  const calls: number[] = [];
  const activity: [number, number][] = [];
  const cache = new RangeCache(data.length, async (s, e) => (calls.push(s), data.slice(s, e)), (n, b) => activity.push([n, b]), 1000);
  await cache.read(0, 10);
  expect(activity).toEqual([[1, 0], [0, 1000]]);
  for (let i = 1; i <= 14; i++) await cache.read(i * 2000, 10); // more than it keeps
  expect(calls.length).toBe(15);
  await cache.read(0, 10); // the first piece was dropped: it is asked for again
  expect(calls.length).toBe(16);
  await cache.read(14 * 2000, 10); // a recent one is still there
  expect(calls.length).toBe(16);
});
