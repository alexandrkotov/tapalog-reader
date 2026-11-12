import type { OcrBox } from "../ocrBoxes";
import { framedIn, layoutScanText, type ScanLine } from "./scanText";
import type { Rect } from "./types";

/**
 * Makes the pages of a recognized scan selectable: the words the recognizer found are laid over the picture in no colour, so a
 * word can be selected, copied and found by the browser's own search, while the PDF itself is never changed. The frames of the
 * words come from the server, a page at a time and only for the pages that have them.
 */

export interface ScanTextOptions {
  bookId: string;
  /** The element of page `n` of the viewer, when it has one. */
  pageEl(n: number): HTMLElement | null;
  /** The cut of page `n` as parts of the whole page, or null when the page is shown whole. */
  cutOf(n: number): Rect | null;
  /** Width over height of page `n` as drawn before the reader's turn (cut as it is cut), or null while that is not known. */
  aspectOf(n: number): number | null;
  /** How far the reader has turned the pages, clockwise, in degrees. */
  turn(): number;
  pageCount(): number;
  /** Called when the words of page `n` are on it (the element is the page), so something can be done with them (marked). */
  onLayer?(n: number, pageEl: HTMLElement): void;
}

export interface ScanText {
  /** Puts the words on page `n` (again, when the viewer has emptied the page's element). */
  show(n: number): void;
  /** Lays every page out again: the cut or the turn changed, or the list of pages arrived. */
  refresh(): void;
  destroy(): void;
}

/** The book's id in the address the reader loads it from, or null for any other address (a shared link has no way to the words). */
export const bookIdOf = (url: string): string | null => /^\/api\/file\/([^/?#]+)/.exec(url)?.[1] ?? null;

/** The width of a word in ems of the font the layer draws in; measured the way the browser sets it. */
function measurer(): (text: string) => number {
  const g = document.createElement("canvas").getContext("2d");
  if (g) g.font = "100px sans-serif";
  const seen = new Map<string, number>();
  return (text) => {
    let ems = seen.get(text);
    if (ems === undefined) {
      ems = g ? g.measureText(text).width / 100 : text.length * 0.5;
      seen.set(text, ems);
    }
    return ems;
  };
}

/** The words as elements: a frame turned like the pages, in it a row per line, in it a span per word with a space between. */
export function buildScanLayer(lines: ScanLine[], turn: number): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "ocr-layer";
  const frame = document.createElement("div");
  frame.className = "ocr-frame";
  frame.dataset.turn = String(turn);
  frame.style.setProperty("--turn", `${turn}deg`);
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = "ocr-line";
    Object.assign(row.style, { left: `${line.left}%`, top: `${line.top}%` });
    line.words.forEach((word, i) => {
      if (i) row.append(" "); // what a copied line has between its words
      const span = document.createElement("span");
      span.className = "ocr-word";
      span.textContent = word.text;
      Object.assign(span.style, {
        marginLeft: `${word.margin}cqw`,
        marginTop: `${word.top}cqh`,
        width: `${word.width}cqw`,
        height: `${word.height}cqh`,
        lineHeight: `${word.height}cqh`,
        fontSize: `${word.font}cqh`,
        transform: `scaleX(${word.scale})`,
      });
      row.append(span);
    });
    row.append("\n"); // a copied page keeps its lines, and the browser's word selection stops at the end of one (the row keeps it: white-space is pre)
    frame.append(row);
  }
  layer.append(frame);
  return layer;
}

export function createScanText(options: ScanTextOptions): ScanText {
  let destroyed = false;
  let known: Set<number> | null = null; // the pages that have words; null until the server has said
  const measure = measurer();
  const words = new Map<number, Promise<OcrBox[] | null>>();
  const layers = new Map<number, { el: HTMLElement; key: string }>();
  const building = new Map<number, number>();
  const base = `/api/ocr/${encodeURIComponent(options.bookId)}/boxes`;

  const fetchJson = async <T>(url: string): Promise<T | null> => {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null; // a page without selectable words is the page as it always was
    }
  };

  const keyOf = (n: number) => `${JSON.stringify(options.cutOf(n))}|${options.turn()}`;

  function show(n: number): void {
    if (destroyed || !known?.has(n)) return;
    const div = options.pageEl(n);
    if (!div) return;
    const key = keyOf(n);
    const have = layers.get(n);
    if (have?.key === key) {
      if (have.el.parentElement !== div) div.append(have.el);
      options.onLayer?.(n, div);
      return;
    }
    const token = (building.get(n) ?? 0) + 1;
    building.set(n, token);
    if (!words.has(n)) words.set(n, fetchJson<{ boxes: OcrBox[] }>(`${base}/${n}`).then((r) => r?.boxes ?? null));
    void words.get(n)!.then((boxes) => {
      if (destroyed || building.get(n) !== token || !boxes) return;
      const aspect = options.aspectOf(n);
      const target = options.pageEl(n);
      if (!aspect || !target) return;
      const el = buildScanLayer(layoutScanText(framedIn(boxes, options.cutOf(n)), aspect, measure), options.turn());
      layers.get(n)?.el.remove();
      layers.set(n, { el, key: keyOf(n) });
      target.append(el);
      options.onLayer?.(n, target);
    });
  }

  function refresh(): void {
    for (let n = 1; n <= options.pageCount(); n++) show(n);
  }

  void fetchJson<{ pages: number[] }>(base).then((r) => {
    if (destroyed || !r?.pages.length) return;
    known = new Set(r.pages);
    refresh();
  });

  return {
    show,
    refresh,
    destroy() {
      destroyed = true;
      for (const { el } of layers.values()) el.remove();
      layers.clear();
    },
  };
}
