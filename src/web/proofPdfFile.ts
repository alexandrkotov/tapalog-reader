import fontUrl from "@ecm/viewer-engine/fonts/DejaVuSans.ttf";
import type FontkitModule from "@pdf-lib/fontkit";
import type * as PdfLibModule from "pdf-lib";
import type { PDFDocument, PDFFont, PDFImage } from "pdf-lib";
import { blocksOf, DEFAULT_STYLE, layoutBook, PAGE_FORMATS, type BookText, type PageFormatName, type Role } from "./proofPdf";

/**
 * Writes the new PDF: the text of the book set in DejaVu Sans (which has the Cyrillic letters; only the letters used are kept in
 * the file) with the figures cut from the scan. The layout is decided by `layoutBook`; this puts it on the sheets. It lives in a
 * file of its own so that the PDF library is fetched only when somebody exports.
 *
 * The library is not imported: the program's page is one piece, and two imports would put 1.9 MB into every visit. It comes as the
 * two ready-made scripts the server holds at /pdflib/ (see scripts/gen-pdflib-assets.ts), added to the page on the first export.
 */

type PdfLib = typeof PdfLibModule;
type Fontkit = typeof FontkitModule;

let loading: Promise<{ lib: PdfLib; fontkit: Fontkit }> | null = null;

function addScript(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `/pdflib/${name}`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`${name} could not be loaded`));
    document.head.append(script);
  });
}

/** pdf-lib and its font reader, fetched once; when that fails the next export tries again. */
function loadPdfLib(): Promise<{ lib: PdfLib; fontkit: Fontkit }> {
  loading ??= Promise.all([addScript("pdf-lib.min.js"), addScript("fontkit.umd.min.js")]).then(
    () => {
      const g = globalThis as unknown as { PDFLib?: PdfLib; fontkit?: Fontkit };
      if (!g.PDFLib || !g.fontkit) throw new Error("the PDF library did not start");
      return { lib: g.PDFLib, fontkit: g.fontkit };
    },
    (e) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

export interface PdfBook {
  title: string;
  note?: string;
  pages: { page: number; text: string }[];
  pageLabel: ((page: number) => string) | null;
  missing: (alt: string) => string;
  /** The file of a figure the text refers to (a PNG). */
  figure: (name: string) => Promise<Blob>;
}

export interface PdfProgress {
  stage: "figures" | "pages";
  done: number;
  total: number;
}

/** The figures are kept no sharper than this for paper, and only this big a part of the sheet's width is ever used. */
const FIGURE_DPI = DEFAULT_STYLE.figureDpi;
/** A figure is stored as JPEG when that is this much smaller than the PNG (photographs and halftones); drawings stay lossless. */
const JPEG_WINS = 0.4;
const JPEG_QUALITY = 0.9;
/** The outline that thickens bold letters, as a share of the type size. */
const BOLD_STROKE = 0.03;

/** What the font has no letter for is shown as a question mark rather than as an empty box, and what cannot be seen is dropped. */
function drawable(text: string, known: Set<number>): string {
  let out = "";
  for (const ch of text.replace(/[\u00AD\u200B-\u200F\u2028\u2029\uFEFF]/g, "").replace(/[\u00A0\t]/g, " ")) {
    const code = ch.codePointAt(0)!;
    out += code === 10 ? ch : code < 32 ? " " : code === 32 || known.has(code) ? ch : "?"; // the line breaks stay: the layout reads them
  }
  return out;
}

interface Prepared {
  image: PDFImage;
  width: number;
  height: number;
}

/** A figure for paper: shrunk to what the sheet can show, then kept as PNG or, when that is much smaller, as JPEG. */
async function prepareFigure(doc: PDFDocument, blob: Blob, maxWidth: number): Promise<Prepared> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, 0, 0, width, height);
    const toBlob = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    const png = await toBlob("image/png");
    const jpeg = await toBlob("image/jpeg", JPEG_QUALITY);
    canvas.width = canvas.height = 0;
    if (!png) throw new Error("the figure could not be encoded");
    if (jpeg && jpeg.size < png.size * JPEG_WINS) return { image: await doc.embedJpg(new Uint8Array(await jpeg.arrayBuffer())), width, height };
    return { image: await doc.embedPng(new Uint8Array(await png.arrayBuffer())), width, height };
  } finally {
    bitmap.close();
  }
}

export async function buildBookPdf(book: PdfBook, opts: { format: PageFormatName; onProgress?: (p: PdfProgress) => void; signal?: AbortSignal }): Promise<Uint8Array> {
  const stop = () => {
    if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
  };
  const format = PAGE_FORMATS[opts.format];
  const { lib, fontkit } = await loadPdfLib();
  stop();
  const { PDFDocument, rgb } = lib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
  const font: PDFFont = await doc.embedFont(fontBytes, { subset: true });
  const known = new Set(font.getCharacterSet());
  stop();

  const text = (s: string) => drawable(s, known);
  const pages = book.pages.map((p) => ({ page: p.page, text: text(p.text) }));
  const names = [...new Set(pages.flatMap((p) => blocksOf(p.text).flatMap((b) => (b.kind === "figure" ? [b.name] : []))))];

  // the figures first: their sizes decide the layout
  const prepared = new Map<string, Prepared>();
  const contentWidth = format.width - 2 * format.margin;
  for (const [i, name] of names.entries()) {
    stop();
    opts.onProgress?.({ stage: "figures", done: i, total: names.length });
    try {
      prepared.set(name, await prepareFigure(doc, await book.figure(name), Math.ceil((contentWidth * FIGURE_DPI) / 72)));
    } catch {
      /* a figure that cannot be had is told in words where it would stand */
    }
  }
  opts.onProgress?.({ stage: "figures", done: names.length, total: names.length });

  const input: BookText = {
    title: text(book.title),
    note: book.note ? text(book.note) : undefined,
    pages,
    pageLabel: book.pageLabel ? (n) => text(book.pageLabel!(n)) : null,
    figures: new Map([...prepared].map(([name, p]) => [name, { width: p.width, height: p.height }])),
    missing: (alt) => text(book.missing(alt)),
  };
  const laid = layoutBook(input, format, (s, size) => font.widthOfTextAtSize(s, size));

  const colors: Record<Role, ReturnType<typeof rgb>> = {
    title: rgb(0, 0, 0),
    heading: rgb(0.15, 0.15, 0.15),
    body: rgb(0, 0, 0),
    note: rgb(0.4, 0.4, 0.4),
    missing: rgb(0.45, 0.45, 0.45),
    quote: rgb(0.3, 0.3, 0.3),
    formula: rgb(0, 0, 0),
    code: rgb(0.1, 0.1, 0.1),
  };
  for (const [index, sheet] of laid.entries()) {
    stop();
    opts.onProgress?.({ stage: "pages", done: index, total: laid.length });
    const page = doc.addPage([format.width, format.height]);
    for (const item of sheet.items) {
      if (item.kind === "text") {
        // the font has one weight and no slant: bold is the letters outlined as well as filled (still one piece of text, so it is selected and searched once), italic is slanted
        const color = colors[item.role];
        if (item.bold) page.pushOperators(lib.pushGraphicsState(), lib.setTextRenderingMode(lib.TextRenderingMode.FillAndOutline), lib.setLineWidth(item.size * BOLD_STROKE), lib.setStrokingColor(color));
        page.drawText(item.text, { x: item.x, y: format.height - item.y - item.size, size: item.size, font, color, ...(item.italic ? { xSkew: lib.degrees(12) } : {}) });
        if (item.bold) page.pushOperators(lib.popGraphicsState());
      } else if (item.kind === "box") {
        page.drawRectangle({ x: item.x, y: format.height - item.y - item.height, width: item.width, height: item.height, color: rgb(0.93, 0.94, 0.95) });
      } else {
        page.drawImage(prepared.get(item.name)!.image, { x: item.x, y: format.height - item.y - item.height, width: item.width, height: item.height });
      }
    }
    const foot = `${index + 1} / ${laid.length}`;
    page.drawText(foot, { x: (format.width - font.widthOfTextAtSize(foot, 8)) / 2, y: format.margin / 2 - 4, size: 8, font, color: rgb(0.5, 0.5, 0.5) });
  }
  opts.onProgress?.({ stage: "pages", done: laid.length, total: laid.length });

  doc.setTitle(text(book.title));
  doc.setProducer("Tapalog Reader");
  doc.setCreator("Tapalog Reader");
  return doc.save();
}
