import { expect, test } from "bun:test";
import { fetchBlob, readWithProgress, type Progress } from "./download";

const streamOf = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
    { headers },
  );

test("a body is counted as it arrives, against the size the server announced, and comes out whole", async () => {
  const seen: Progress[] = [];
  const blob = await readWithProgress(streamOf([new Uint8Array(100).fill(1), new Uint8Array(50).fill(2), new Uint8Array(30).fill(3)], { "Content-Length": "180", "Content-Type": "application/pdf" }), (p) => seen.push(p));
  expect(seen).toEqual([
    { loaded: 0, total: 180 },
    { loaded: 100, total: 180 },
    { loaded: 150, total: 180 },
    { loaded: 180, total: 180 },
  ]);
  expect(blob.size).toBe(180);
  expect(blob.type).toBe("application/pdf");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect([bytes[0], bytes[100], bytes[179]]).toEqual([1, 2, 3]);
});

test("the size is not promised when it is not announced or the body is compressed on the way", async () => {
  const none: Progress[] = [];
  await readWithProgress(streamOf([new Uint8Array(10)]), (p) => none.push(p));
  expect(none.at(-1)).toEqual({ loaded: 10, total: null });
  const packed: Progress[] = [];
  await readWithProgress(streamOf([new Uint8Array(10)], { "Content-Length": "4", "Content-Encoding": "gzip" }), (p) => packed.push(p));
  expect(packed.every((p) => p.total === null)).toBe(true);
});

test("a file that cannot be fetched is an error with the server's words, and one that can is a Blob", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("no", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    await expect(fetchBlob("/x")).rejects.toThrow("404 Not Found");
    globalThis.fetch = (async () => new Response("hello")) as unknown as typeof fetch;
    expect(await (await fetchBlob("/x", () => {})).text()).toBe("hello");
  } finally {
    globalThis.fetch = original;
  }
});
