import { pdfDocumentOptions } from "./readers/pdfAssets";
import { boxesOf, type FoundBlock, type OcrBox } from "./ocrBoxes";
import { runOcr, type OcrOutcome, type OcrProgress } from "./ocrRun";
import { api } from "./ui";

/**
 * Reads the pictures of a scanned PDF in the administrator's browser, like the covers are drawn: pdf.js draws
 * a page, tesseract.js (from /ocr/, inside the program) reads it in a worker, and the text goes to the server
 * page by page, so a stop or a closed tab loses at most the pages in hand.
 */

export type OcrLang = "rus" | "rus+eng";
export const OCR_LANGS: OcrLang[] = ["rus", "rus+eng"];

/** A page is drawn about this tall (and not wider than MAX_WIDTH): enough for small print, which the reader is not asked to enlarge. */
const PAGE_HEIGHT = 2200;
const MAX_WIDTH = 3200;
const MAX_LANES = 4;

/** The smallest WebAssembly module that uses SIMD: the engine's core is built for it. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** Whether this browser can run the engine at all (workers, WebAssembly with SIMD). */
export function ocrSupported(): boolean {
  try {
    return typeof Worker === "function" && typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** How many pages are read at once: a core for the page's own work is left free, and four readers are the most that is worth their memory. */
export function defaultLanes(cores = navigator.hardwareConcurrency || 2): number {
  return Math.max(1, Math.min(MAX_LANES, cores - 1));
}

/** The book cannot be read: it needs a password, or is not a PDF the engine can open. */
export class OcrBookError extends Error {}

interface Recognizer {
  recognize(image: HTMLCanvasElement, options: object, output: { text: boolean; blocks: boolean }): Promise<{ data: { text: string; blocks: FoundBlock[] | null } }>;
  setParameters(params: Record<string, unknown>): Promise<unknown>;
  terminate(): Promise<unknown>;
}
interface Tesseract {
  createWorker(langs: string[], oem: number, options: Record<string, unknown>): Promise<Recognizer>;
  PSM: { AUTO: string };
}

let loading: Promise<Tesseract> | null = null;

/** The tesseract.js script, loaded when the first book is read (not with the page). */
function loadTesseract(): Promise<Tesseract> {
  loading ??= new Promise<Tesseract>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/ocr/tesseract.min.js";
    script.onload = () => resolve((globalThis as unknown as { Tesseract: Tesseract }).Tesseract);
    script.onerror = () => {
      loading = null; // asked again next time
      reject(new Error("the engine could not be loaded"));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * The readers (tesseract workers) of one run. Making one means fetching the engine and the language data and starting its
 * WebAssembly, which is most of the wait before the first page; a run of several books makes them once, for the first book,
 * adds the ones a bigger book needs, and ends them with `close`.
 */
export class Readers {
  private workers: Recognizer[] = [];
  private turn: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly lang: OcrLang) {}

  /** At least `n` readers, made now if they are not there yet. */
  ensure(n: number): Promise<Recognizer[]> {
    const next = this.turn.then(async () => {
      if (this.closed) throw new Error("the readers are closed");
      const Tesseract = await loadTesseract();
      const origin = location.origin;
      const langs = this.lang.split("+");
      // all of them are waited for, even when one fails: a reader that is ready after `close` would never be ended
      const made = await Promise.allSettled(
        Array.from({ length: Math.max(0, n - this.workers.length) }, async () => {
          const worker = await Tesseract.createWorker(langs, 1, {
            workerPath: `${origin}/ocr/worker.min.js`,
            corePath: `${origin}/ocr/core/tesseract-core-simd-lstm.wasm.js`,
            langPath: `${origin}/ocr/lang`,
            gzip: true,
            cacheMethod: "none", // the browser's own cache keeps the files; no second copy in a database
          });
          this.workers.push(worker); // kept before the next step, so `close` ends it even when that fails
          await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO }); // the default merges the lines of two columns
        }),
      );
      for (const m of made) if (m.status === "rejected") throw m.reason;
      return this.workers.slice(0, n);
    });
    this.turn = next.catch(() => undefined);
    return next;
  }

  /** Ends every reader; the ones still being made are ended when they are ready. */
  async close(): Promise<void> {
    this.closed = true;
    await this.turn;
    const all = this.workers.splice(0);
    await Promise.all(all.map((w) => w.terminate().catch(() => undefined)));
  }
}

export interface RecognizeOptions {
  /** The book's id (a PDF of the library). */
  id: string;
  lang: OcrLang;
  signal?: AbortSignal;
  /** The readers of a run of several books, which the caller closes; without them the book makes its own and ends them. */
  readers?: Readers;
  /** Read once more the pages recognized before without frames of words, so that their text can be selected in the reader. */
  again?: boolean;
  /** Pages at once; the default fits the computer. */
  lanes?: number;
  onProgress?(progress: OcrProgress): void;
  /** "loading" while the engine and the language data are being fetched, then "reading". */
  onState?(state: "loading" | "reading"): void;
}

/** Reads the pages of a book the server does not hold text for yet, until the end, a stop, or a failure of the server. */
export async function recognizeBook(options: RecognizeOptions): Promise<OcrOutcome> {
  if (!ocrSupported()) throw new OcrBookError("this browser cannot run the engine");
  options.onState?.("loading");
  if (options.readers && options.readers.lang !== options.lang) throw new Error("the readers are for another language");
  const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = pdfjs.getDocument(pdfDocumentOptions(`/api/file/${options.id}`));
  task.onPassword = () => void task.destroy();
  const readers = options.readers ?? new Readers(options.lang);
  try {
    const pdf = await task.promise.catch(() => {
      throw new OcrBookError("the PDF cannot be opened (damaged or protected)");
    });
    const { done } = await api<{ done: number[] }>(`/api/admin/ocr/${options.id}/start`, { pages: pdf.numPages, lang: options.lang, ...(options.again ? { again: true } : {}) });
    const lanes = Math.max(1, Math.min(options.lanes ?? defaultLanes(), pdf.numPages - done.length || 1));
    const workers = await readers.ensure(lanes);
    if (options.signal?.aborted) return { done: done.length, pages: pdf.numPages, failed: [], stopped: true };
    options.onState?.("reading");
    const idle = [...workers];
    return await runOcr<HTMLCanvasElement, { text: string; boxes: OcrBox[] }>({
      pages: pdf.numPages,
      done,
      lanes,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      async render(number) {
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(PAGE_HEIGHT / base.height, MAX_WIDTH / base.width) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        page.cleanup();
        return canvas;
      },
      async recognize(canvas) {
        const worker = idle.pop()!; // never more pages in hand than readers
        try {
          // the words with their frames come with the text, for the reader to make the scan selectable
          const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
          return { text: data.text, boxes: boxesOf(data.blocks, canvas.width, canvas.height) };
        } finally {
          idle.push(worker);
        }
      },
      release(canvas) {
        canvas.width = canvas.height = 0; // the memory goes back at once, not when the collector gets round to it
      },
      async upload(page, { text, boxes }) {
        await api(`/api/admin/ocr/${options.id}/pages/${page}`, boxes.length ? { text, boxes } : { text }, "PUT");
      },
    });
  } finally {
    if (!options.readers) await readers.close();
    void task.destroy();
  }
}
