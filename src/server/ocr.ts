import type { Database } from "bun:sqlite";

/** Recognized text of one page is cut here: a page of a book holds a few thousand characters, not a hundred thousand. */
export const MAX_PAGE_CHARS = 100_000;
export const MAX_PAGES = 20_000;
const LANGS = new Set(["rus", "rus+eng"]);

export interface OcrProgress {
  pages: number;
  done: number;
  lang: string;
  updated: number;
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
    db.run("CREATE TABLE IF NOT EXISTS ocr_pages (id TEXT NOT NULL, page INTEGER NOT NULL, row INTEGER, PRIMARY KEY (id, page)) WITHOUT ROWID");
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
      const old = this.db.query("SELECT row FROM ocr_pages WHERE id = ? AND page = ?").get(id, page) as { row: number | null } | null;
      if (old?.row) this.db.run("DELETE FROM ocr_chunks WHERE rowid = ?", [old.row]);
      let row: number | null = null;
      if (text) row = Number(this.db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES (?, ?, ?)", [text, id, JSON.stringify({ page })]).lastInsertRowid);
      this.db.run("INSERT INTO ocr_pages (id, page, row) VALUES (?, ?, ?) ON CONFLICT(id, page) DO UPDATE SET row = excluded.row", [id, page, row]);
      this.db.run("UPDATE ocr_docs SET updated = ? WHERE id = ?", [Date.now(), id]);
    })();
    return { done: (this.db.query("SELECT COUNT(*) AS n FROM ocr_pages WHERE id = ?").get(id) as { n: number }).n, pages: doc.pages };
  }

  progress(id: string): OcrProgress | null {
    return this.all().get(id) ?? null;
  }

  /** The reading of every book that has begun. */
  all(): Map<string, OcrProgress> {
    const rows = this.db.query("SELECT d.id, d.pages, d.lang, d.updated, (SELECT COUNT(*) FROM ocr_pages p WHERE p.id = d.id) AS done FROM ocr_docs d").all() as (OcrProgress & { id: string })[];
    return new Map(rows.map((r) => [r.id, { pages: r.pages, done: r.done, lang: r.lang, updated: r.updated }]));
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
