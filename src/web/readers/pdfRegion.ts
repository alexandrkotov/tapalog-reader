import * as pdfjsLib from "pdfjs-dist/build/pdf.min.mjs";
import { pdfDocumentOptions } from "./pdfAssets";
import { rectToScreen } from "./rotation";
import type { Rect } from "./types";

/** A picture is drawn to fit in this many CSS pixels, and a tiny area is not enlarged beyond this scale (it would only blur). */
const BOX_W = 260;
const BOX_H = 180;
const MAX_SCALE = 4;
const WHOLE: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** The rectangle of a view when it is a real one inside the page; otherwise the whole page. */
function regionOf(value: unknown): Rect {
  const r = value as Partial<Rect> | null | undefined;
  if (!r || ![r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n))) return WHOLE;
  const x = Math.min(1, Math.max(0, r.x!));
  const y = Math.min(1, Math.max(0, r.y!));
  const w = Math.min(1 - x, r.w!);
  const h = Math.min(1 - y, r.h!);
  return w > 0.001 && h > 0.001 ? { x, y, w, h } : WHOLE;
}

/** The box a picture is fitted in (CSS pixels) and how sharp it is drawn (device pixels per CSS pixel). */
export interface PictureSize {
  w: number;
  h: number;
  dpr?: number;
}

export interface PdfPictures {
  /**
   * The area of a view (or the page, when it has none) drawn upright as the reader sees the book (`turn` is the
   * reader's own turn of the pages), or null when it cannot be drawn: the page is not there, the PDF needs a
   * password, the file cannot be read. Nothing but the file the reader may open is used.
   */
  picture(view: unknown, turn: number, signal: AbortSignal, size?: PictureSize): Promise<HTMLCanvasElement | null>;
  close(): void;
}

/** Draws pictures of areas of one PDF; the document is fetched on the first picture and shared by the rest. */
export function openPdfPictures(url: string): PdfPictures {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
  let closed = false;
  const load = () => {
    task ??= pdfjsLib.getDocument(pdfDocumentOptions(url)); // no password prompt here: a protected file simply has no picture
    return task.promise;
  };
  return {
    async picture(view, turn, signal, size = { w: BOX_W, h: BOX_H }) {
      try {
        const asked = Math.round(Number((view as { page?: unknown } | null)?.page));
        const pdf = await load();
        if (signal.aborted || closed || !(asked >= 1 && asked <= pdf.numPages)) return null;
        const page = await pdf.getPage(asked);
        const rotation = (page.rotate + turn) % 360;
        const base = page.getViewport({ scale: 1, rotation });
        const r = rectToScreen(regionOf((view as { region?: unknown }).region), turn); // the area as the turned page shows it
        const dpr = size.dpr ?? Math.min(2, devicePixelRatio || 1);
        const scale = Math.min(MAX_SCALE, size.w / (r.w * base.width), size.h / (r.h * base.height));
        const k = scale * dpr;
        const viewport = page.getViewport({ scale: k, rotation, offsetX: -r.x * base.width * k, offsetY: -r.y * base.height * k });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(r.w * base.width * k));
        canvas.height = Math.max(1, Math.round(r.h * base.height * k));
        canvas.style.width = `${canvas.width / dpr}px`;
        canvas.style.height = `${canvas.height / dpr}px`;
        if (signal.aborted || closed) return null;
        await page.render({ canvas, viewport }).promise;
        page.cleanup();
        return signal.aborted || closed ? null : canvas;
      } catch {
        return null;
      }
    },
    close() {
      closed = true;
      void task?.destroy();
    },
  };
}
