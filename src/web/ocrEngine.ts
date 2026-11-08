import { pdfDocumentOptions } from "./readers/pdfAssets";
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
  recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }>;
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

export interface RecognizeOptions {
  /** The book's id (a PDF of the library). */
  id: string;
  lang: OcrLang;
  signal?: AbortSignal;
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
  const [Tesseract, pdfjs] = await Promise.all([loadTesseract(), import("pdfjs-dist/build/pdf.min.mjs")]);
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = pdfjs.getDocument(pdfDocumentOptions(`/api/file/${options.id}`));
  task.onPassword = () => void task.destroy();
  const workers: Recognizer[] = [];
  try {
    const pdf = await task.promise.catch(() => {
      throw new OcrBookError("the PDF cannot be opened (damaged or protected)");
    });
    const { done } = await api<{ done: number[] }>(`/api/admin/ocr/${options.id}/start`, { pages: pdf.numPages, lang: options.lang });
    const lanes = Math.max(1, Math.min(options.lanes ?? defaultLanes(), pdf.numPages - done.length || 1));
    const origin = location.origin;
    const langs = options.lang.split("+");
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        const worker = await Tesseract.createWorker(langs, 1, {
          workerPath: `${origin}/ocr/worker.min.js`,
          corePath: `${origin}/ocr/core/tesseract-core-simd-lstm.wasm.js`,
          langPath: `${origin}/ocr/lang`,
          gzip: true,
          cacheMethod: "none", // the browser's own cache keeps the files; no second copy in a database
        });
        workers.push(worker);
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO }); // the default merges the lines of two columns
      }),
    );
    if (options.signal?.aborted) return { done: done.length, pages: pdf.numPages, failed: [], stopped: true };
    options.onState?.("reading");
    const idle = [...workers];
    return await runOcr<HTMLCanvasElement>({
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
          return (await worker.recognize(canvas)).data.text;
        } finally {
          idle.push(worker);
        }
      },
      release(canvas) {
        canvas.width = canvas.height = 0; // the memory goes back at once, not when the collector gets round to it
      },
      async upload(page, text) {
        await api(`/api/admin/ocr/${options.id}/pages/${page}`, { text }, "PUT");
      },
    });
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
    void task.destroy();
  }
}
