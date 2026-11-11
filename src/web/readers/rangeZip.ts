import { configure, ZipReader, BlobWriter, TextWriter } from "foliate-js/vendor/zip.js";
import { makeComicBook } from "foliate-js/comic-book.js";
import { readWithProgress, type Progress } from "./download";

/**
 * Reading a comic (a ZIP of pictures) without downloading it first: the list of pages is at the end of the file, and a page is
 * one stretch of it, so the reader asks the server for those stretches (a `Range` request) and nothing else. A hundred-megabyte
 * comic then opens after a few hundred kilobytes, and each page costs only its own size.
 */

/** How much is asked for at a time: a page is read in a few such pieces rather than in a request for every 64 KB. */
export const PIECE = 1024 * 1024;
/** How many pieces are kept (the pages next to the one on screen are read ahead, and the reader may turn back). */
const KEEP = 12;

interface Piece {
  start: number;
  bytes: Uint8Array;
}

/**
 * Hands out stretches of a file of known size, asking `fetchRange(start, end)` (end not included) for what it does not have yet:
 * at least a whole piece at a time, so reading a page in small steps makes one request, not dozens. A stretch that is already
 * on its way is waited for instead of being asked for twice.
 */
export class RangeCache {
  private pieces: Piece[] = [];
  private flying: { start: number; end: number; promise: Promise<Uint8Array> }[] = [];
  private burst = 0;

  constructor(
    readonly size: number,
    private fetchRange: (start: number, end: number) => Promise<Uint8Array>,
    private onActivity: (pending: number, bytes: number) => void = () => {},
    private piece = PIECE,
  ) {}

  /** Keeps bytes that came with the first answer (the end of the file). */
  seed(start: number, bytes: Uint8Array): void {
    this.remember({ start, bytes });
  }

  private remember(piece: Piece): void {
    this.pieces.push(piece);
    if (this.pieces.length > KEEP) this.pieces.shift();
  }

  private find(start: number, end: number): Piece | undefined {
    return this.pieces.find((p) => p.start <= start && p.start + p.bytes.length >= end);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, offset);
    const end = Math.min(this.size, offset + length);
    if (end <= start) return new Uint8Array(0);
    for (;;) {
      const have = this.find(start, end);
      if (have) {
        // a used piece is the last to be dropped
        this.pieces.splice(this.pieces.indexOf(have), 1);
        this.pieces.push(have);
        return have.bytes.slice(start - have.start, end - have.start); // a copy: zip.js reads `.buffer` and would take a view for the whole piece
      }
      const coming = this.flying.find((f) => f.start <= start && f.end >= end);
      if (coming) {
        await coming.promise;
        continue; // now in the pieces (or the request failed and throws here)
      }
      const to = Math.min(this.size, start + Math.max(end - start, this.piece));
      await this.ask(start, to);
    }
  }

  private ask(start: number, end: number): Promise<Uint8Array> {
    if (!this.flying.length) this.burst = 0;
    const entry = { start, end, promise: undefined as unknown as Promise<Uint8Array> };
    entry.promise = this.fetchRange(start, end).then(
      (bytes) => {
        this.burst += bytes.length;
        this.remember({ start, bytes });
        this.finish(entry);
        return bytes;
      },
      (err: unknown) => {
        this.finish(entry);
        throw err;
      },
    );
    this.flying.push(entry);
    this.onActivity(this.flying.length, this.burst);
    return entry.promise;
  }

  private finish(entry: { start: number; end: number }): void {
    this.flying.splice(this.flying.indexOf(entry as never), 1);
    this.onActivity(this.flying.length, this.burst);
  }
}

/** The shape of a reader that zip.js takes: its size, its bytes by stretch, and a stream of the bytes of the entry it is on. */
class ZipSource {
  size: number;
  constructor(private cache: RangeCache) {
    this.size = cache.size;
  }
  async init(): Promise<void> {}
  readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    return this.cache.read(offset, length);
  }
  /** zip.js sets `offset` and `size` on the stream before reading an entry, and the stream reads that stretch in steps. */
  get readable(): ReadableStream<Uint8Array> {
    const source = this;
    const step = 64 * 1024;
    let at = 0;
    const stream: ReadableStream<Uint8Array> & { offset?: number; size?: number } = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const base = stream.offset ?? 0;
        const total = stream.size;
        const n = total === undefined ? step : Math.min(step, total - at);
        const data = await source.readUint8Array(base + at, n);
        controller.enqueue(data);
        if (total === undefined ? !data.length : at + step >= total || data.length < step) controller.close();
        else at += step;
      },
    });
    return stream;
  }
}

/** What the text engine takes to read a ZIP: its entries, and the text or bytes of one by name; each read asks the cache for just that entry. */
export async function zipLoader(cache: RangeCache) {
  configure({ useWebWorkers: false });
  const zip = new ZipReader(new ZipSource(cache));
  const entries: { filename: string; uncompressedSize?: number; getData(writer: unknown): Promise<unknown> }[] = await zip.getEntries();
  const byName = new Map(entries.map((entry) => [entry.filename, entry]));
  const load = <A extends unknown[]>(f: (entry: (typeof entries)[number], ...args: A) => unknown) => (n: string, ...args: A) => (byName.has(n) ? f(byName.get(n)!, ...args) : null);
  return {
    entries,
    loadText: load((entry) => entry.getData(new TextWriter())) as (name: string) => Promise<string> | null,
    loadBlob: load((entry, type: string) => entry.getData(new BlobWriter(type))) as (name: string, type?: string) => Promise<Blob> | null,
    getSize: (n: string) => byName.get(n)?.uncompressedSize ?? 0,
  };
}

export interface RangedComic {
  /** A book in the shape the text engine takes, or null when the server would not answer by stretches (then `file` is the whole file). */
  book: unknown;
  file: File | null;
  /** Stops what is still being asked for. */
  dispose(): void;
}

export interface ComicHooks {
  onProgress(progress: Progress): void;
  /** How many requests are in flight, and how many bytes came in since the wait began. */
  onBusy(pending: number, bytes: number): void;
}

/**
 * Opens a comic from the library or a share link. The first request asks for the end of the file: a server that answers by
 * stretches (206) gives the list of pages with it and the rest is read as it is needed; one that sends the whole file anyway
 * (200) has it read to the end, with the count of bytes going to `onProgress`, and the file is returned whole.
 */
export async function openComic(url: string, name: string, hooks: ComicHooks): Promise<RangedComic> {
  const stop = new AbortController();
  const get = (range: string) => fetch(url, { credentials: "include", headers: { Range: range }, signal: stop.signal });
  const res = await get(`bytes=-${PIECE}`);
  if (res.status === 200) {
    const blob = await readWithProgress(res, hooks.onProgress);
    return { book: null, file: new File([blob], name, { type: "application/vnd.comicbook+zip" }), dispose: () => stop.abort() };
  }
  const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1]);
  if (res.status !== 206 || !Number.isFinite(total) || total <= 0) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 416 || res.status === 206) {
      // an empty file, or a size that was not told: the whole file is fetched the plain way and the text engine says what it makes of it
      const plain = await fetch(url, { credentials: "include", signal: stop.signal });
      if (!plain.ok) throw new Error(`${plain.status} ${plain.statusText}`);
      return { book: null, file: new File([await readWithProgress(plain, hooks.onProgress)], name, { type: "application/vnd.comicbook+zip" }), dispose: () => stop.abort() };
    }
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const tail = new Uint8Array(await res.arrayBuffer());
  hooks.onProgress({ loaded: tail.length, total: null });
  const fetchRange = async (start: number, end: number): Promise<Uint8Array> => {
    const r = await get(`bytes=${start}-${end - 1}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const all = new Uint8Array(await r.arrayBuffer());
    return r.status === 200 ? all.slice(start, end) : all; // a server that forgot the range sends everything
  };
  const cache = new RangeCache(total, fetchRange, hooks.onBusy);
  cache.seed(total - tail.length, tail);

  const loader = await zipLoader(cache);
  return { book: makeComicBook(loader, { name }), file: null, dispose: () => stop.abort() };
}
