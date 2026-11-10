import { unzipSync } from "fflate";
import { OWN_MIN_CHARS } from "../../web/ocrOwn";
import { decodeText } from "../../web/readers/decode";
import { htmlToText } from "./html";
import { mobiText } from "./mobi";

/** Where in the book a piece of text is, in the terms of the format. */
export type Loc = { page: number } | { offset: number } | { section: number } | { fraction: number } | { image: number; link?: number };

export interface Chunk {
  text: string;
  loc: Loc;
}

/** What an extractor tells about the file besides its text. A PDF says how many pages it has and how many of them have text. */
export interface ExtractMeta {
  /** Pages of the PDF; 0 when there are too many to be read page by page (nothing is then said of its pages). */
  pages?: number;
  /** Pages with enough text of their own to be taken as they are (the same measure the recognizing of scans uses). */
  textPages?: number;
}

/** The book has no text we can index (a scan, a locked file); not an error. */
export class NoText extends Error {}

const CHUNK = 1500;
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const MAX_PAGES = 6000;
const MAX_CHARS = 60_000_000;

/** Cuts text at whitespace into pieces of about `size` characters, remembering where each starts. */
export function chunkText(text: string, size = CHUNK): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) {
      const cut = text.lastIndexOf("\n", end);
      const space = cut > at + size * 0.5 ? cut : text.lastIndexOf(" ", end);
      if (space > at + size * 0.5) end = space;
    }
    const piece = text.slice(at, end);
    if (piece.trim()) out.push({ start: at, text: piece });
    at = end;
  }
  return out;
}

async function readCapped(path: string): Promise<Uint8Array> {
  const file = Bun.file(path);
  if (file.size > MAX_FILE_BYTES) throw new NoText("file too large to index");
  return file.bytes();
}

/** The text of each page of a PDF, one after another; `meta` is filled as the pages go by. */
async function* pdfPages(path: string, meta: ExtractMeta): AsyncGenerator<{ page: number; text: string }> {
  // pdf.js grumbles on load that it has no canvas to draw with; we only read text, so keep the console clean.
  const warn = console.warn;
  console.warn = () => {};
  let pdfjs: typeof import("pdfjs-dist");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Run pdf.js's worker in this thread: there is no separate worker file in a single executable.
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  } finally {
    console.warn = warn;
  }
  const task = pdfjs.getDocument({ data: await readCapped(path), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  task.onPassword = () => void task.destroy();
  try {
    const doc = await task.promise;
    meta.pages = doc.numPages <= MAX_PAGES ? doc.numPages : 0;
    meta.textPages = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : " ") : "")).join("").replace(/[ \t]+/g, " ").trim();
      page.cleanup();
      if (text.replace(/\s/g, "").length >= OWN_MIN_CHARS) meta.textPages!++;
      yield { page: n, text };
      if (n % 5 === 0) await Bun.sleep(0); // let the server answer requests between pages
    }
  } catch (err) {
    if ((err as { name?: string }).name === "PasswordException") throw new NoText("password protected");
    throw err;
  } finally {
    void task.destroy();
  }
}

async function* pdfChunks(path: string, meta: ExtractMeta = {}): AsyncGenerator<Chunk> {
  for await (const { page, text } of pdfPages(path, meta)) for (const piece of chunkText(text, 4000)) yield { text: piece.text, loc: { page } };
}

/** How many pages a PDF has and how many have text, without keeping any of it; null when it cannot be read (locked, damaged). */
export async function measurePdf(path: string): Promise<{ pages: number; textPages: number } | null> {
  const meta: ExtractMeta = {};
  try {
    for await (const _ of pdfPages(path, meta)) void _;
  } catch {
    return null;
  }
  return { pages: meta.pages ?? 0, textPages: meta.textPages ?? 0 };
}

async function* txtChunks(path: string): AsyncGenerator<Chunk> {
  const text = decodeText(await readCapped(path)).slice(0, MAX_CHARS);
  for (const piece of chunkText(text)) yield { text: piece.text, loc: { offset: piece.start } };
}

/** Text of a whole book cut into chunks that remember how far into the book they are (0..1). */
function* byFraction(text: string): Generator<Chunk> {
  const clipped = text.slice(0, MAX_CHARS);
  for (const piece of chunkText(clipped)) yield { text: piece.text, loc: { fraction: piece.start / Math.max(1, clipped.length) } };
}

async function* fb2Chunks(path: string): AsyncGenerator<Chunk> {
  const bytes = await readCapped(path);
  // FB2 files from the Russian-speaking world are very often windows-1251; the XML declaration says so.
  const label = /^<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 200)))?.[1] ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(label).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  yield* byFraction(htmlToText(text));
}

async function* mobiChunks(path: string): AsyncGenerator<Chunk> {
  const text = mobiText(await readCapped(path));
  if (text === null) throw new NoText("locked or unsupported MOBI");
  yield* byFraction(text);
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((x) => x !== undefined);
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
const join = (base: string, href: string) => {
  const parts = (base + href).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
};

async function* epubChunks(path: string): AsyncGenerator<Chunk> {
  const files = unzipSync(await readCapped(path), { filter: (f) => /\.(x?html?|xml|opf)$/i.test(f.name) });
  const text = (name: string) => (files[name] ? new TextDecoder().decode(files[name]) : null);
  const container = text("META-INF/container.xml");
  const opfPath = container && attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] ?? "", "full-path");
  const opf = opfPath ? text(opfPath) : null;
  if (!opfPath || !opf) throw new Error("not an EPUB");
  const manifest = new Map<string, string>();
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    if (id && href) manifest.set(id, href);
  }
  let section = 0;
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    const href = manifest.get(attr(tag, "idref") ?? "");
    const index = section++;
    const html = href ? text(join(dirOf(opfPath), decodeURIComponent(href.split("#")[0]!))) : null;
    if (!html) continue;
    for (const piece of chunkText(htmlToText(html))) yield { text: piece.text, loc: { section: index } };
    if (index % 5 === 0) await Bun.sleep(0);
  }
}

async function* ecatmChunks(path: string): AsyncGenerator<Chunk> {
  const { catalogChunks } = await import("../ecatmCover");
  for (const c of await catalogChunks(path)) yield { text: c.text, loc: { image: c.imageId, ...(c.linkId !== undefined ? { link: c.linkId } : {}) } };
}

export const EXTRACTORS: Record<string, (path: string, meta?: ExtractMeta) => AsyncGenerator<Chunk>> = {
  pdf: pdfChunks,
  txt: txtChunks,
  fb2: fb2Chunks,
  mobi: mobiChunks,
  epub: epubChunks,
  ecatm: ecatmChunks,
};
