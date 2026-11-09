import type { Database } from "bun:sqlite";
import { strToU8, zipSync } from "fflate";

/** Recognized text of one page is cut here: a page of a book holds a few thousand characters, not a hundred thousand. */
export const MAX_PAGE_CHARS = 100_000;
export const MAX_PAGES = 20_000;
/** A picture cut from a page: a PNG, and a book keeps a few hundred of them at most. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGES = 1000;
const LANGS = new Set(["rus", "rus+eng"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The name of a picture cut from a page, as the Markdown refers to it: `images/p008-1.png`. */
export const IMAGE_NAME = /^p\d{3,5}-\d{1,4}\.png$/;
const IMAGE_REF = /!\[[^\]\n]*\]\(images\/p\d{3,5}-\d{1,4}\.png\)/g;

/** The text of a page without the references to its pictures: what the search reads and what plain text shows. */
export function withoutImages(text: string): string {
  return text.replace(IMAGE_REF, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Without the g flag: a regular expression with it remembers where it stopped, and the next search would begin there. */
const hasImages = (text: string): boolean => new RegExp(IMAGE_REF.source).test(text);

/** The names of the pictures a text refers to. */
export function imagesIn(text: string): string[] {
  return [...text.matchAll(new RegExp(IMAGE_REF))].map((m) => m[0].slice(m[0].lastIndexOf("(") + 1, -1).slice("images/".length));
}

/** A word the recognizer found on a page: the word, then the corners of its frame as parts of the page's width and height, from the top left. */
export type OcrBox = [word: string, x0: number, y0: number, x1: number, y1: number];
/** A page holds a few thousand words at most; what a halftone makes of its dots beyond this is not kept. */
export const MAX_BOXES = 8000;
const MAX_BOX_WORD = 100;

/**
 * The frames of the words of a page, made fit to keep: the shape must be right (null when it is not), the words lose what cannot
 * be shown, the corners are held to the page and to four decimals, and a frame with no area is dropped.
 */
export function cleanBoxes(raw: unknown): OcrBox[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_BOXES * 4) return null;
  const out: OcrBox[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 5 || typeof item[0] !== "string" || item.slice(1).some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
    // eslint-disable-next-line no-control-regex
    const word = item[0].replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, "").slice(0, MAX_BOX_WORD);
    const [x0, y0, x1, y1] = (item.slice(1) as number[]).map((n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000) as [number, number, number, number];
    if (word && x1 > x0 && y1 > y0 && out.length < MAX_BOXES) out.push([word, x0, y0, x1, y1]);
  }
  return out;
}

export interface OcrImage {
  name: string;
  page: number;
  size: number;
}

export interface OcrProgress {
  pages: number;
  done: number;
  /** Pages a person has corrected (or written) by hand: the reading of the book never replaces them. */
  edited: number;
  /** Pictures cut from the scan and kept with the text. */
  images: number;
  lang: string;
  updated: number;
}

/** One page as the editor shows it. */
export interface OcrPage {
  page: number;
  text: string;
  edited: boolean;
}

export interface OcrRow {
  rowid: number;
  id: string;
  loc: string;
  snip: string;
  rank: number;
}

/**
 * What the recognizer read from a page, made fit for the index: control characters out (two of them
 * mark the words found in a snippet), a word split by a hyphen at the end of a line joined again, and
 * the line breaks inside a paragraph turned into spaces.
 */
export function cleanOcrText(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/(\p{L})[-­]\n(?=\p{Ll})/gu, "$1")
    .replace(/(?<!\n)\n(?!\n)/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
}

/** Text typed by a person: the paragraphs and lines are theirs, so only what would break the index is taken out. */
export function cleanEditedText(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
}

export type ExportFormat = "md" | "txt";
export const exportFormat = (v: unknown): v is ExportFormat => v === "md" || v === "txt";

/** The Markdown of a book with the pictures it refers to, as one zip: `book.md` and the `images/` folder. */
export function zipOcrText(markdown: string, images: { name: string; data: Uint8Array }[]): Uint8Array {
  const used = new Set(imagesIn(markdown));
  const files: Record<string, [Uint8Array, { level: 0 }]> = { "book.md": [strToU8(markdown), { level: 0 }] };
  for (const image of images) if (used.has(image.name)) files[`images/${image.name}`] = [image.data, { level: 0 }];
  return zipSync(files);
}

const WORDS: Record<string, { page: string; partial: string }> = {
  en: { page: "Page", partial: "Recognized pages: {done} of {total}." },
  ru: { page: "Страница", partial: "Распознано страниц: {done} из {total}." },
  uk: { page: "Сторінка", partial: "Розпізнано сторінок: {done} із {total}." },
};

/**
 * The text of a book as a file: the title, then every page that has text under its number. Markdown marks a page with a
 * heading, plain text with the number in brackets. A book not recognized to the end says how far it got.
 */
export function renderOcrText(opts: { title: string; pages: OcrPage[]; total: number; done: number; format: ExportFormat; lang?: string }): string {
  const words = WORDS[opts.lang ?? "en"] ?? WORDS.en!;
  const md = opts.format === "md";
  const out: string[] = [md ? `# ${opts.title}` : opts.title];
  if (opts.done < opts.total) {
    const how = words.partial.replace("{done}", String(opts.done)).replace("{total}", String(opts.total));
    out.push(md ? `> ${how}` : how);
  }
  for (const page of opts.pages) {
    if (!page.text) continue;
    const text = md ? page.text : withoutImages(page.text);
    if (!text) continue;
    out.push(md ? `## ${words.page} ${page.page}` : `[${words.page} ${page.page}]`, text);
  }
  return out.join("\n\n") + "\n";
}

export const validLang = (lang: unknown): lang is string => typeof lang === "string" && LANGS.has(lang);

/**
 * Text read from the pictures of scanned pages by the administrator's browser, kept in the full-text
 * database beside the index but apart from it: reading a scan takes hours, so emptying the index
 * must not lose it. One row per page; searched together with the index.
 */
export class OcrText {
  constructor(private readonly db: Database) {
    db.run("CREATE TABLE IF NOT EXISTS ocr_docs (id TEXT PRIMARY KEY, pages INTEGER NOT NULL, lang TEXT NOT NULL, updated INTEGER NOT NULL)");
    // `row` is the rowid of the page's text in ocr_chunks; null for a page with nothing on it
    // `edited`: a person has written the page; `orig` keeps what the recognizer read before the first correction (null: the page had not been read)
    db.run("CREATE TABLE IF NOT EXISTS ocr_pages (id TEXT NOT NULL, page INTEGER NOT NULL, row INTEGER, edited INTEGER NOT NULL DEFAULT 0, orig TEXT, PRIMARY KEY (id, page)) WITHOUT ROWID");
    // `md`: the whole text of a page that refers to pictures (the index holds it without the references); null for a page that does not
    db.run("CREATE TABLE IF NOT EXISTS ocr_images (id TEXT NOT NULL, name TEXT NOT NULL, page INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, name)) WITHOUT ROWID");
    // `data`: the frames of the words of a page as the recognizer read it (JSON, see `cleanBoxes`); a page written by hand keeps them, hidden, for `restore`
    db.run("CREATE TABLE IF NOT EXISTS ocr_boxes (id TEXT NOT NULL, page INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, page)) WITHOUT ROWID");
    const columns = (db.query("PRAGMA table_info(ocr_pages)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("edited")) db.run("ALTER TABLE ocr_pages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("orig")) db.run("ALTER TABLE ocr_pages ADD COLUMN orig TEXT");
    if (!columns.includes("md")) db.run("ALTER TABLE ocr_pages ADD COLUMN md TEXT");
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS ocr_chunks USING fts5(text, id UNINDEXED, loc UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')");
  }

  /** Begins (or goes on with) the reading of a book of `pages` pages; the pages already read are returned. A different page count means a different file: start again. */
  start(id: string, pages: number, lang: string): number[] {
    const known = this.progress(id);
    if (known && known.pages !== pages) this.remove(id);
    this.db.run("INSERT INTO ocr_docs (id, pages, lang, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET lang = excluded.lang, updated = excluded.updated", [id, pages, lang, Date.now()]);
    return (this.db.query("SELECT page FROM ocr_pages WHERE id = ? ORDER BY page").all(id) as { page: number }[]).map((r) => r.page);
  }

  /**
   * Stores the text of one page (replacing an earlier reading of it) and, when the recognizer gave them, the frames of its words;
   * a reading without frames leaves none behind, for they would belong to the old one. Null when the book was not started or the page is not in it.
   */
  put(id: string, page: number, raw: string, boxes: OcrBox[] = []): { done: number; pages: number } | null {
    const doc = this.db.query("SELECT pages FROM ocr_docs WHERE id = ?").get(id) as { pages: number } | null;
    if (!doc || !Number.isInteger(page) || page < 1 || page > doc.pages) return null;
    const text = cleanOcrText(raw);
    this.db.transaction(() => {
      const old = this.db.query("SELECT row, edited FROM ocr_pages WHERE id = ? AND page = ?").get(id, page) as { row: number | null; edited: number } | null;
      if (old?.edited) return; // a person has written this page: the recognizer never replaces it
      if (old?.row) this.db.run("DELETE FROM ocr_chunks WHERE rowid = ?", [old.row]);
      let row: number | null = null;
      if (text) row = Number(this.db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES (?, ?, ?)", [text, id, JSON.stringify({ page })]).lastInsertRowid);
      this.db.run("INSERT INTO ocr_pages (id, page, row) VALUES (?, ?, ?) ON CONFLICT(id, page) DO UPDATE SET row = excluded.row", [id, page, row]);
      if (text && boxes.length) this.db.run("INSERT INTO ocr_boxes (id, page, data) VALUES (?, ?, ?) ON CONFLICT(id, page) DO UPDATE SET data = excluded.data", [id, page, JSON.stringify(boxes)]);
      else this.db.run("DELETE FROM ocr_boxes WHERE id = ? AND page = ?", [id, page]);
      this.db.run("UPDATE ocr_docs SET updated = ? WHERE id = ?", [Date.now(), id]);
    })();
    return { done: (this.db.query("SELECT COUNT(*) AS n FROM ocr_pages WHERE id = ?").get(id) as { n: number }).n, pages: doc.pages };
  }

  /** The frames of the words of a page, for the reader to lay over the scan. Null when the page has none, or has been written by hand (its words are no longer the frames'). */
  boxes(id: string, page: number): OcrBox[] | null {
    const row = this.db.query("SELECT b.data, p.edited FROM ocr_boxes b JOIN ocr_pages p ON p.id = b.id AND p.page = b.page WHERE b.id = ? AND b.page = ?").get(id, page) as { data: string; edited: number } | null;
    return row && !row.edited ? (JSON.parse(row.data) as OcrBox[]) : null;
  }

  private textOf(row: number | null): string {
    return row ? ((this.db.query("SELECT text FROM ocr_chunks WHERE rowid = ?").get(row) as { text: string } | null)?.text ?? "") : "";
  }

  /** The pages of a book that have an entry (read or written), from `from` to `to`, with their text. */
  pages(id: string, from = 1, to = MAX_PAGES): OcrPage[] {
    const rows = this.db.query("SELECT page, row, edited, md FROM ocr_pages WHERE id = ? AND page BETWEEN ? AND ? ORDER BY page").all(id, from, to) as { page: number; row: number | null; edited: number; md: string | null }[];
    return rows.map((r) => ({ page: r.page, text: r.md ?? this.textOf(r.row), edited: r.edited === 1 }));
  }

  /**
   * A person writes the text of a page (a page not read yet included). The reading's own text is kept for `restore`, and the
   * page is searched by what was written. Null when the book was not started or the page is not in it.
   */
  edit(id: string, page: number, raw: string): { done: number; pages: number; edited: number } | null {
    const doc = this.db.query("SELECT pages FROM ocr_docs WHERE id = ?").get(id) as { pages: number } | null;
    if (!doc || !Number.isInteger(page) || page < 1 || page > doc.pages) return null;
    const full = cleanEditedText(raw);
    const text = withoutImages(full);
    const md = hasImages(full) ? full : null; // the index never sees the references to pictures
    this.db.transaction(() => {
      const old = this.db.query("SELECT row, edited, orig FROM ocr_pages WHERE id = ? AND page = ?").get(id, page) as { row: number | null; edited: number; orig: string | null } | null;
      const orig = old?.edited ? old.orig : old ? this.textOf(old.row) : null; // the first correction keeps what was read
      if (old?.row) this.db.run("DELETE FROM ocr_chunks WHERE rowid = ?", [old.row]);
      const row = text ? Number(this.db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES (?, ?, ?)", [text, id, JSON.stringify({ page })]).lastInsertRowid) : null;
      this.db.run("INSERT INTO ocr_pages (id, page, row, edited, orig, md) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id, page) DO UPDATE SET row = excluded.row, edited = 1, orig = excluded.orig, md = excluded.md", [id, page, row, orig, md]);
      this.db.run("UPDATE ocr_docs SET updated = ? WHERE id = ?", [Date.now(), id]);
    })();
    const count = (extra: string) => (this.db.query(`SELECT COUNT(*) AS n FROM ocr_pages WHERE id = ?${extra}`).get(id) as { n: number }).n;
    return { done: count(""), pages: doc.pages, edited: count(" AND edited = 1") };
  }

  /**
   * Takes a corrected page back to what the reading gave. The answer holds the page as it is now, or null for it when the
   * page had never been read (it becomes unread again). Null as the whole answer: the page has no corrections to undo.
   */
  restore(id: string, page: number): { page: OcrPage | null } | null {
    const old = this.db.query("SELECT row, edited, orig FROM ocr_pages WHERE id = ? AND page = ?").get(id, page) as { row: number | null; edited: number; orig: string | null } | null;
    if (!old?.edited) return null;
    let result: OcrPage | null = null;
    this.db.transaction(() => {
      if (old.row) this.db.run("DELETE FROM ocr_chunks WHERE rowid = ?", [old.row]);
      if (old.orig === null) {
        this.db.run("DELETE FROM ocr_pages WHERE id = ? AND page = ?", [id, page]);
        this.db.run("DELETE FROM ocr_boxes WHERE id = ? AND page = ?", [id, page]);
      } else {
        const row = old.orig ? Number(this.db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES (?, ?, ?)", [old.orig, id, JSON.stringify({ page })]).lastInsertRowid) : null;
        this.db.run("UPDATE ocr_pages SET row = ?, edited = 0, orig = NULL, md = NULL WHERE id = ? AND page = ?", [row, id, page]);
        result = { page, text: old.orig, edited: false };
      }
      this.db.run("UPDATE ocr_docs SET updated = ? WHERE id = ?", [Date.now(), id]);
    })();
    return { page: result };
  }

  /**
   * Keeps a picture cut from a page of a book (a PNG) and names it `p008-1.png`, the page and a number. Null when the book was
   * not started, the page is not in it, the bytes are not a PNG or too big, or the book holds too many pictures already.
   */
  addImage(id: string, page: number, data: Uint8Array): OcrImage | null {
    const doc = this.db.query("SELECT pages FROM ocr_docs WHERE id = ?").get(id) as { pages: number } | null;
    if (!doc || !Number.isInteger(page) || page < 1 || page > doc.pages) return null;
    if (data.length < 33 || data.length > MAX_IMAGE_BYTES || PNG_SIGNATURE.some((b, i) => data[i] !== b)) return null;
    if ((this.db.query("SELECT COUNT(*) AS n FROM ocr_images WHERE id = ?").get(id) as { n: number }).n >= MAX_IMAGES) return null;
    const prefix = `p${String(page).padStart(3, "0")}-`;
    const taken = (this.db.query("SELECT name FROM ocr_images WHERE id = ? AND page = ?").all(id, page) as { name: string }[]).map((r) => Number(r.name.slice(prefix.length, -4)));
    const name = `${prefix}${Math.max(0, ...taken) + 1}.png`;
    this.db.run("INSERT INTO ocr_images (id, name, page, data) VALUES (?, ?, ?, ?)", [id, name, page, data]);
    return { name, page, size: data.length };
  }

  /** The pictures a book has, in page order. */
  images(id: string): OcrImage[] {
    return this.db.query("SELECT name, page, length(data) AS size FROM ocr_images WHERE id = ? ORDER BY page, length(name), name").all(id) as OcrImage[];
  }

  image(id: string, name: string): Uint8Array | null {
    const row = this.db.query("SELECT data FROM ocr_images WHERE id = ? AND name = ?").get(id, name) as { data: Uint8Array } | null;
    return row?.data ?? null;
  }

  /** The bytes of every picture of a book, for the zip. */
  imageFiles(id: string): { name: string; data: Uint8Array }[] {
    return this.db.query("SELECT name, data FROM ocr_images WHERE id = ?").all(id) as { name: string; data: Uint8Array }[];
  }

  /** Deletes a picture and the references to it from the pages; those pages as they are now. Null when the book has no such picture. */
  removeImage(id: string, name: string): OcrPage[] | null {
    if (!this.image(id, name)) return null;
    const changed: OcrPage[] = [];
    this.db.transaction(() => {
      this.db.run("DELETE FROM ocr_images WHERE id = ? AND name = ?", [id, name]);
      const ref = new RegExp(`!\\[[^\\]\\n]*\\]\\(images/${name.replace(/\./g, "\\.")}\\)`, "g");
      for (const r of this.db.query("SELECT page, md FROM ocr_pages WHERE id = ? AND md IS NOT NULL").all(id) as { page: number; md: string }[]) {
        if (!ref.test(r.md)) continue;
        ref.lastIndex = 0;
        this.edit(id, r.page, r.md.replace(ref, ""));
        changed.push(...this.pages(id, r.page, r.page));
      }
    })();
    return changed;
  }

  progress(id: string): OcrProgress | null {
    return this.all().get(id) ?? null;
  }

  /** The reading of every book that has begun. */
  all(): Map<string, OcrProgress> {
    const rows = this.db.query("SELECT d.id, d.pages, d.lang, d.updated, (SELECT COUNT(*) FROM ocr_pages p WHERE p.id = d.id) AS done, (SELECT COUNT(*) FROM ocr_pages p WHERE p.id = d.id AND p.edited = 1) AS edited, (SELECT COUNT(*) FROM ocr_images i WHERE i.id = d.id) AS images FROM ocr_docs d").all() as (OcrProgress & { id: string })[];
    return new Map(rows.map((r) => [r.id, { pages: r.pages, done: r.done, edited: r.edited, images: r.images, lang: r.lang, updated: r.updated }]));
  }

  /** Forgets everything read from a book; how many pages that was. */
  remove(id: string): number {
    const pages = (this.db.query("SELECT COUNT(*) AS n FROM ocr_pages WHERE id = ?").get(id) as { n: number }).n;
    this.db.transaction(() => {
      for (const r of this.db.query("SELECT row FROM ocr_pages WHERE id = ? AND row IS NOT NULL").all(id) as { row: number }[]) this.db.run("DELETE FROM ocr_chunks WHERE rowid = ?", [r.row]);
      this.db.run("DELETE FROM ocr_pages WHERE id = ?", [id]);
      this.db.run("DELETE FROM ocr_images WHERE id = ?", [id]);
      this.db.run("DELETE FROM ocr_boxes WHERE id = ?", [id]);
      this.db.run("DELETE FROM ocr_docs WHERE id = ?", [id]);
    })();
    return pages;
  }

  totals(): { books: number; pages: number } {
    const row = this.db.query("SELECT (SELECT COUNT(*) FROM ocr_docs) AS books, (SELECT COUNT(*) FROM ocr_pages) AS pages").get() as { books: number; pages: number };
    return row;
  }

  /** Pages with the words, for the search to weigh beside the index's own. */
  rows(match: string, open: string, close: string, book: string | undefined, limit: number): OcrRow[] {
    const sql = `SELECT rowid, id, loc, snippet(ocr_chunks, 0, ?, ?, '…', 16) AS snip, rank FROM ocr_chunks WHERE ocr_chunks MATCH ?${book ? " AND id = ?" : ""} ORDER BY rank LIMIT ${limit}`;
    return this.db.query(sql).all(...(book ? [open, close, match, book] : [open, close, match])) as OcrRow[];
  }
}
