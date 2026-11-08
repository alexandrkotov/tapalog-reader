import { expect, test } from "bun:test";
import { etaSeconds, runOcr, splitEta, type OcrProgress, type OcrSteps } from "./ocrRun";

/** Stand-ins: a page "draws" as its number, "reads" as `text <n>`, and every call is noted. */
function steps(over: Partial<OcrSteps<number>> = {}, log: string[] = []): OcrSteps<number> & { log: string[]; uploaded: Map<number, string>; open: number; peak: number } {
  const state = { log, uploaded: new Map<number, string>(), open: 0, peak: 0 };
  return Object.assign(state, {
    async render(page: number) {
      log.push(`render ${page}`);
      return page;
    },
    async recognize(image: number) {
      state.open++;
      state.peak = Math.max(state.peak, state.open);
      await Bun.sleep(5);
      state.open--;
      return `text ${image}`;
    },
    release(image: number) {
      log.push(`release ${image}`);
    },
    async upload(page: number, text: string) {
      state.uploaded.set(page, text);
    },
    ...over,
  });
}

test("every page the server lacks is read and handed over, those it has are left alone, and the lanes work side by side", async () => {
  const s = steps();
  const progress: OcrProgress[] = [];
  const out = await runOcr({ ...s, pages: 6, done: [2, 5], lanes: 3, onProgress: (p) => progress.push(p) });
  expect([...s.uploaded.keys()].sort()).toEqual([1, 3, 4, 6]);
  expect(s.uploaded.get(3)).toBe("text 3");
  expect(out).toEqual({ done: 6, pages: 6, failed: [], stopped: false });
  expect(s.peak).toBe(3); // three at once, never more
  expect(s.log.filter((x) => x.startsWith("release")).length).toBe(4); // everything drawn was freed
  expect(progress[0]).toMatchObject({ done: 2, pages: 6, etaSeconds: null });
  expect(progress.at(-1)).toMatchObject({ done: 6, pages: 6, failed: [] });
});

test("a page that fails is tried once more, and one that fails twice is set aside while the rest go on", async () => {
  let tries = 0;
  const s = steps({
    async recognize(image: number) {
      if (image === 2) throw new Error("always");
      if (image === 3 && tries++ === 0) throw new Error("once");
      return `text ${image}`;
    },
  });
  const out = await runOcr({ ...s, pages: 4, done: [], lanes: 2 });
  expect(out).toEqual({ done: 3, pages: 4, failed: [2], stopped: false });
  expect(s.uploaded.get(3)).toBe("text 3"); // read on the second try
  expect(s.uploaded.has(2)).toBe(false);
  expect(s.log.filter((x) => x === "render 2").length).toBe(2); // the page and its one more try
  expect(s.log.filter((x) => x === "release 2").length).toBe(2); // each try freed its picture
});

test("a stop lets the pages in hand finish and starts no others", async () => {
  const stop = new AbortController();
  const s = steps({
    async upload(page: number, text: string) {
      s.uploaded.set(page, text);
      if (page === 2) stop.abort();
    },
  });
  const out = await runOcr({ ...s, pages: 20, done: [], lanes: 1, signal: stop.signal });
  expect(out.stopped).toBe(true);
  expect(out.done).toBe(2);
  expect([...s.uploaded.keys()]).toEqual([1, 2]);
});

test("a stop before the start reads nothing, and a stop after the last page is not a stop", async () => {
  const early = new AbortController();
  early.abort();
  const s = steps();
  expect(await runOcr({ ...s, pages: 3, done: [], lanes: 2, signal: early.signal })).toEqual({ done: 0, pages: 3, failed: [], stopped: true });
  expect(s.uploaded.size).toBe(0);
  const late = new AbortController();
  const t = steps({
    async upload(page: number, text: string) {
      t.uploaded.set(page, text);
      if (page === 2) late.abort();
    },
  });
  expect((await runOcr({ ...t, pages: 2, done: [], lanes: 1, signal: late.signal })).stopped).toBe(false);
});

test("a failed upload ends the run with what went wrong, and nothing is claimed as done", async () => {
  const boom = new Error("server is gone");
  const s = steps({
    async upload(page: number, text: string) {
      if (page === 3) throw boom;
      s.uploaded.set(page, text);
    },
  });
  const out = await runOcr({ ...s, pages: 10, done: [], lanes: 1 });
  expect(out.error).toBe(boom);
  expect(out.done).toBe(2);
  expect(out.stopped).toBe(false);
  expect([...s.uploaded.keys()]).toEqual([1, 2]);
});

test("all pages already held: nothing to do", async () => {
  const s = steps();
  expect(await runOcr({ ...s, pages: 3, done: [1, 2, 3], lanes: 4 })).toEqual({ done: 3, pages: 3, failed: [], stopped: false });
  expect(s.log).toEqual([]);
});

test("the time left goes by the speed so far, and is told the way people say it", () => {
  expect(etaSeconds(0, 100, 5000)).toBeNull();
  expect(etaSeconds(10, 90, 20_000)).toBe(180); // 2 s a page, 90 left
  expect(splitEta(40)).toEqual({ hours: 0, minutes: 0, seconds: 40 });
  expect(splitEta(0.2)).toEqual({ hours: 0, minutes: 0, seconds: 1 });
  expect(splitEta(14 * 60)).toEqual({ hours: 0, minutes: 14, seconds: 0 });
  expect(splitEta(2 * 3600 + 5 * 60)).toEqual({ hours: 2, minutes: 5, seconds: 0 });
  expect(splitEta(3 * 3600)).toEqual({ hours: 3, minutes: 0, seconds: 0 });
});
