/**
 * The layout of a recognized book as the pages of a new PDF. Nothing here draws: it turns the text of the pages (with the references
 * to the figures cut from the scan) into where every line and picture goes, so it can be tested without a PDF library, and the
 * code that writes the file only has to put what is said here on the sheets. Distances are in points (1/72 inch), `y` counts
 * down from the top edge of the sheet.
 */

/** A sheet and its margin, in points. */
export interface PageFormat {
  width: number;
  height: number;
  margin: number;
}

export const PAGE_FORMATS = {
  a4: { width: 595.28, height: 841.89, margin: 54 },
  a5: { width: 419.53, height: 595.28, margin: 42 },
} satisfies Record<string, PageFormat>;
export type PageFormatName = keyof typeof PAGE_FORMATS;
export const pageFormatName = (v: unknown): v is PageFormatName => v === "a4" || v === "a5";

/** Sizes of the type, in points, and how much room is left around what is set. */
export interface Style {
  body: number;
  title: number;
  heading: number;
  note: number;
  /** Line height as a multiple of the type size. */
  leading: number;
  /** Space between paragraphs as a multiple of the body size. */
  paragraphGap: number;
  /** Space above and below a figure, in points. */
  figureGap: number;
  /** A figure is no sharper than this when placed at its own size (pixels per inch). */
  figureDpi: number;
}

export const DEFAULT_STYLE: Style = { body: 11, title: 20, heading: 12, note: 9, leading: 1.4, paragraphGap: 0.7, figureGap: 8, figureDpi: 200 };

/** A part of the text of a page: lines as they were typed, or a reference to a figure. */
export type Block = { kind: "lines"; lines: string[] } | { kind: "figure"; name: string; alt: string };

/** `![Fig. 8.1](images/p008-1.png)`: only the figures this program cuts are meant, never a link to somewhere else. */
const FIGURE = /!\[([^\]\n]*)\]\(images\/(p\d{3,5}-\d{1,4}\.png)\)/g;

/**
 * Cuts the text of a page into paragraphs and figures. A blank line parts paragraphs; a line break inside a paragraph stays
 * (the person typed it), and a figure written in the middle of a line splits the line there.
 */
export function blocksOf(raw: string): Block[] {
  const blocks: Block[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) blocks.push({ kind: "lines", lines });
    lines = [];
  };
  for (const paragraph of raw.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split(/\n[ \t]*\n+/)) {
    for (const line of paragraph.split("\n")) {
      let from = 0;
      for (const match of line.matchAll(new RegExp(FIGURE))) {
        const before = line.slice(from, match.index).trim();
        if (before) lines.push(before);
        flush();
        blocks.push({ kind: "figure", name: match[2]!, alt: match[1]! });
        from = match.index + match[0].length;
      }
      const rest = from ? line.slice(from).trim() : line.trimEnd();
      if (rest || !from) lines.push(rest);
    }
    flush();
  }
  return blocks.filter((b) => b.kind === "figure" || b.lines.some((l) => l.trim()));
}

/** Measures a piece of text set in the given size, in points. */
export type Measure = (text: string, size: number) => number;

/**
 * Breaks one line of text into lines no wider than `width`: at the spaces, and inside a word only when the word alone is wider.
 * Runs of spaces become one. An empty line stays one empty line (it is a gap the person left).
 */
export function wrapLine(text: string, width: number, size: number, measure: Measure): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const out: string[] = [];
  let line = "";
  const put = (word: string) => {
    let rest = word;
    while (measure(rest, size) > width && rest.length > 1) {
      // a word wider than the line: as much of it as fits, the rest on the next
      let cut = 1;
      while (cut < rest.length && measure(rest.slice(0, cut + 1), size) <= width) cut++;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  };
  for (const word of words) {
    if (!line) put(word);
    else if (measure(`${line} ${word}`, size) <= width) line += ` ${word}`;
    else {
      out.push(line);
      put(word);
    }
  }
  if (line) out.push(line);
  return out;
}

export interface BookText {
  title: string;
  /** Says how far the recognition got, when it is not whole. */
  note?: string;
  /** The pages that have an entry, in order; a page without text and figures is left out. */
  pages: { page: number; text: string }[];
  /** The heading above the text of each page ("Page 8"), or null for none. */
  pageLabel: ((page: number) => string) | null;
  /** The size in pixels of every figure that can be drawn; a figure that is not here is told in words. */
  figures: ReadonlyMap<string, { width: number; height: number }>;
  /** What is set for a figure that cannot be drawn, from its description. */
  missing: (alt: string) => string;
}

export type Role = "title" | "note" | "heading" | "body" | "missing";
export type Item = { kind: "text"; x: number; y: number; text: string; size: number; role: Role } | { kind: "image"; x: number; y: number; width: number; height: number; name: string };
export interface LaidPage {
  items: Item[];
}

/** Where everything goes on the sheets. At least one sheet comes out, even for a book with nothing in it. */
export function layoutBook(book: BookText, format: PageFormat, measure: Measure, style: Style = DEFAULT_STYLE): LaidPage[] {
  const pages: LaidPage[] = [{ items: [] }];
  const left = format.margin;
  const width = format.width - 2 * format.margin;
  const top = format.margin;
  const bottom = format.height - format.margin;
  let y = top;
  const current = () => pages[pages.length - 1]!;
  const newSheet = () => {
    pages.push({ items: [] });
    y = top;
  };
  const room = (height: number) => y + height <= bottom + 0.01;
  /** Sets the lines (already broken), one after another, a new sheet where one is full. */
  const setLines = (lines: string[], size: number, role: Role) => {
    const step = size * style.leading;
    for (const text of lines) {
      if (!room(step) && y > top) newSheet();
      if (text) current().items.push({ kind: "text", x: left, y, text, size, role });
      y += step;
    }
  };
  const gap = (points: number) => {
    if (y > top) y += points;
  };
  /** How big a figure is drawn: at its own size for paper, no wider than the text and no taller than a sheet; null when it cannot be drawn. */
  const figureBox = (name: string): { width: number; height: number } | null => {
    const size = book.figures.get(name);
    if (!size) return null;
    const ownWidth = (size.width * 72) / style.figureDpi;
    const ownHeight = (size.height * 72) / style.figureDpi;
    const shrink = Math.min(1, width / ownWidth, (bottom - top - 2 * style.figureGap) / ownHeight);
    return { width: ownWidth * shrink, height: ownHeight * shrink };
  };

  setLines(wrapLine(book.title, width, style.title, measure), style.title, "title");
  if (book.note) {
    gap(style.note);
    setLines(wrapLine(book.note, width, style.note, measure), style.note, "note");
  }
  gap(style.body);

  for (const page of book.pages) {
    const blocks = blocksOf(page.text);
    if (!blocks.length) continue;
    if (book.pageLabel) {
      // a heading is never alone at the foot of a sheet: it needs room for the first line (or figure) after it
      const first = blocks[0]!;
      const box = first.kind === "figure" ? figureBox(first.name) : null;
      const firstHeight = box ? box.height + 2 * style.figureGap : style.body * style.leading;
      const need = 2 * style.body * style.paragraphGap + style.heading * style.leading + firstHeight;
      if (!room(need) && y > top) newSheet();
      gap(style.body * style.paragraphGap);
      setLines([book.pageLabel(page.page)], style.heading, "heading");
    }
    for (const block of blocks) {
      if (block.kind === "lines") {
        gap(style.body * style.paragraphGap);
        for (const line of block.lines) setLines(wrapLine(line, width, style.body, measure), style.body, "body");
        continue;
      }
      const box = figureBox(block.name);
      if (!box) {
        gap(style.body * style.paragraphGap);
        setLines(wrapLine(book.missing(block.alt), width, style.body, measure), style.body, "missing");
        continue;
      }
      const { width: w, height: h } = box;
      if (!room(h + 2 * style.figureGap) && y > top) newSheet();
      gap(style.figureGap);
      current().items.push({ kind: "image", x: left + (width - w) / 2, y, width: w, height: h, name: block.name });
      y += h + style.figureGap;
    }
  }
  return pages;
}
