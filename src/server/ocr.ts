import type { Database } from "bun:sqlite";

/** Recognized text of one page is cut here: a page of a book holds a few thousand characters, not a hundred thousand. */
export const MAX_PAGE_CHARS = 100_000;
export const MAX_PAGES = 20_000;
const LANGS = new Set(["rus", "rus+eng"]);

export interface OcrProgress {
  pages: number;
  done: number;
  /** Pages a person has corrected (or written) by hand: the reading of the book never replaces them. */
  edited: number;
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
    out.push(md ? `## ${words.page} ${page.page}` : `[${words.page} ${page.page}]`, page.text);
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
    const columns = (db.query("PRAGMA table_info(ocr_pages)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("edited")) db.run("ALTER TABLE ocr_pages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("orig")) db.run("ALTER TABLE ocr_pages ADD COLUMN orig TEXT");
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS ocr_chunks USING fts5(text, id UNINDEXED, loc UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')");
  }

  /** Begins (or goes on with) the reading of a book of `pages` pages; the pages already read are returned. A different page count means a different file: start again. */
  start(id: string, pages: number, lang: string): number[] {
    const known = this.progress(id);
    if (known && known.pages !== pages) this.remove(id);
    this.db.run("INSERT INTO ocr_docs (id, pages, lang, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET lang = excluded.lang, updated = excluded.updated", [id, pages, lang, Date.now()]);
    return (this.db.query("SELECT page FROM ocr_pages WHERE id = ? ORDER BY page").all(id) as { page: number }[]).map((r) => r.page);
  }

  /** Stores the text of one page (replacing an earlier reading of it). Null when the book was not started or the page is not in it. */
  put(id: string, page: number, raw: string): { done: number; pages: number } | null {
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
      this.db.run("UPDATE ocr_docs SET updated = ? WHERE id = ?", [Date.now(), id]);
    })();
    return { done: (this.db.query("SELECT COUNT(*) AS n FROM ocr_pages WHERE id = ?").get(id) as { n: number }).n, pages: doc.pages };
  }

  private textOf(row: number | null): string {
    return row ? ((this.db.query("SELECT text FROM ocr_chunks WHERE rowid = ?").get(row) as { text: string } | null)?.text ?? "") : "";
  }

  /** The pages of a book that have an entry (read or written), from `from` to `to`, with their text. */
  pages(id: string, from = 1, to = MAX_PAGES): OcrPage[] {
    const rows = this.db.query("SELECT page, row, edited FROM ocr_pages WHERE id = ? AND page BETWEEN ? AND ? ORDER BY page").all(id, from, to) as { page: number; row: number | null; edited: number }[];
    return rows.map((r) => ({ page: r.page, text: this.textOf(r.row), edited: r.edited === 1 }));
  }

  /**
   * A person writes the text of a page (a page not read yet included). The reading's own text is kept for `restore`, and the
   * page is searched by what was written. Null when the book was not started or the page is not in it.
   */
  edit(id: string, page: number, raw: string): { done: number; pages: number; edited: number } | null {
    const doc = this.db.query("SELECT pages FROM ocr_docs WHERE id = ?").get(id) as { pages: number } | null;
    if (!doc || !Number.isInteger(page) || page < 1 || page > doc.pages) return null;
    const text = cleanEditedText(raw);
    this.db.transaction(() => {
      const old = this.db.query("SELECT row, edited, orig FROM ocr_pages WHERE id = ? AND page = ?").get(id, page) as { row: number | null; edited: number; orig: string | null } | null;
      const orig = old?.edited ? old.orig : old ? this.textOf(old.row) : null; // the first correction keeps what was read
      if (old?.row) this.db.run("DELETE FROM ocr_chunks WHERE rowid = ?", [old.row]);
      const row = text ? Number(this.db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES (?, ?, ?)", [text, id, JSON.stringify({ page })]).lastInsertRowid) : null;
      this.db.run("INSERT INTO ocr_pages (id, page, row, edited, orig) VALUES (?, ?, ?, 1, ?) ON CONFLICT(id, page) DO UPDATE SET row = excluded.row, edited = 1, orig = excluded.orig", [id, page, row, orig]);
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
      } else {
        const row = old.orig ? Number(this.db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES (?, ?, ?)", [old.orig, id, JSON.stringify({ page })]).lastInsertRowid) : null;
        this.db.run("UPDATE ocr_pages SET row = ?, edited = 0, orig = NULL WHERE id = ? AND page = ?", [row, id, page]);
        result = { page, text: old.orig, edited: false };
      }
      this.db.run("UPDATE ocr_docs SET updated = ? WHERE id = ?", [Date.now(), id]);
    })();
    return { page: result };
  }

  progress(id: string): OcrProgress | null {
    return this.all().get(id) ?? null;
  }

  /** The reading of every book that has begun. */
  all(): Map<string, OcrProgress> {
    const rows = this.db.query("SELECT d.id, d.pages, d.lang, d.updated, (SELECT COUNT(*) FROM ocr_pages p WHERE p.id = d.id) AS done, (SELECT COUNT(*) FROM ocr_pages p WHERE p.id = d.id AND p.edited = 1) AS edited FROM ocr_docs d").all() as (OcrProgress & { id: string })[];
    return new Map(rows.map((r) => [r.id, { pages: r.pages, done: r.done, edited: r.edited, lang: r.lang, updated: r.updated }]));
  }

  /** Forgets everything read from a book; how many pages that was. */
  remove(id: string): number {
    const pages = (this.db.query("SELECT COUNT(*) AS n FROM ocr_pages WHERE id = ?").get(id) as { n: number }).n;
    this.db.transaction(() => {
      for (const r of this.db.query("SELECT row FROM ocr_pages WHERE id = ? AND row IS NOT NULL").all(id) as { row: number }[]) this.db.run("DELETE FROM ocr_chunks WHERE rowid = ?", [r.row]);
      this.db.run("DELETE FROM ocr_pages WHERE id = ?", [id]);
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
