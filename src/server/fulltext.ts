import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ConfigStore } from "./config";
import type { BookRow, Library } from "./library";
import { OcrText, type OcrProgress } from "./ocr";
import { EXTRACTORS, NoText, type Loc } from "./text/extract";

/** Bump when an extractor improves, so books indexed by the old one are read again. */
export const EXTRACTOR_VERSION = 1;
export const INDEXABLE: ReadonlySet<string> = new Set(Object.keys(EXTRACTORS));

export interface FullTextStatus {
  enabled: boolean;
  /** Books (distinct contents) that could have text. */
  total: number;
  indexed: number;
  /** Nothing to index: scans, locked files, comics. */
  skipped: number;
  failed: number;
  working: string | null;
  bytes: number;
  /** Scanned books whose pages the administrator's browser has read (or begun to read), and the pages read. */
  recognizedBooks: number;
  recognizedPages: number;
}

/** A PDF that has (almost) no text of its own, so its pictures could be read. */
export interface ScanBook {
  book: BookRow;
  /** How far the reading has got; null when it has not begun. */
  ocr: OcrProgress | null;
}

export interface FullTextHit {
  snippet: string;
  /** Where in the book, in the terms of its format (a page, a section, a share of the book), for the label next to the snippet. */
  loc: Loc;
  /** For a plain text file, how far into the text the words are (0 to 1): a file has no pages to name. */
  share?: number;
  /** The reader's own view object, ready for `#book=…&view=…`. */
  view: Record<string, unknown>;
}

export interface FullTextBook {
  id: string;
  hits: FullTextHit[];
  /** The book has more places with the words than `hits` holds. */
  more: boolean;
}

export interface SearchOptions {
  /** Places shown per book (default 3). */
  perBook?: number;
  /** Books shown (default 40). */
  books?: number;
  /** Only this book: the way to see all of its places. */
  book?: string;
  /** Books the reader's filters let through. */
  accept?: (id: string) => boolean;
}

const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";
const MAX_BOOKS = 40;
const PER_BOOK = 3;
const MAX_PER_BOOK = 100;
const MAX_BOOKS_ASKED = 100;

/** The reader's view of a place in a book, by format. */
export function viewFor(ext: string, loc: Loc, hit?: { start: number; end: number }): Record<string, unknown> {
  if ("page" in loc) return { v: 1, page: loc.page };
  if ("image" in loc) return { v: 1, imageId: loc.image, ...(loc.link !== undefined ? { linkId: loc.link } : {}) };
  if ("offset" in loc) return { v: 1, offset: hit?.start ?? loc.offset, ...(hit ? { range: [hit.start, hit.end] } : {}) };
  if ("section" in loc) return { v: 1, section: loc.section };
  return { v: 1, fraction: Math.round(loc.fraction * 10000) / 10000 };
}

/** FTS5 query for what a person typed: every word must occur, the last one may be unfinished. */
export function matchQuery(q: string): { match: string; words: string[] } | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  if (!words.length) return null;
  return { match: words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" "), words };
}

/**
 * Optional full-text index of the books' contents, in its own database file so it can be
 * thrown away and rebuilt. Books are read one at a time in the background; a book's id is its
 * content, so a rename or move never causes a second read.
 */
export class FullText {
  private db: Database;
  /** Text read from scanned pages: kept when the index is emptied. */
  ocr: OcrText;
  private loop: Promise<void> | null = null;
  private working: string | null = null;
  private stopping = false;

  constructor(
    private readonly dataDir: string,
    private readonly library: Library,
    private readonly config: ConfigStore,
    private readonly startDelayMs = 1500,
  ) {
    this.db = this.open();
    this.ocr = new OcrText(this.db);
  }

  private open(): Database {
    const db = new Database(join(this.dataDir, "fulltext.db"), { create: true });
    db.run("PRAGMA journal_mode = WAL");
    this.createTables(db);
    return db;
  }

  private createTables(db: Database): void {
    db.run(`CREATE TABLE IF NOT EXISTS docs (
      id     TEXT PRIMARY KEY,
      state  TEXT NOT NULL,       -- 'indexing' | 'done' | 'skipped' | 'failed'
      ver    INTEGER NOT NULL,
      first  INTEGER NOT NULL,    -- rowids of this book's chunks: first..last, so they can be removed without a scan
      last   INTEGER NOT NULL,
      note   TEXT,
      seen   INTEGER NOT NULL
    )`);
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, id UNINDEXED, loc UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')");
    // A crash mid-book leaves its chunks without a finished row: the book is the last writer, so drop everything from its start.
    for (const row of db.query("SELECT id, first FROM docs WHERE state = 'indexing'").all() as { id: string; first: number }[]) {
      db.run("DELETE FROM chunks WHERE rowid >= ?", [row.first]);
      db.run("DELETE FROM docs WHERE id = ?", [row.id]);
    }
  }

  get enabled(): boolean {
    return this.config.get().fullText;
  }

  setEnabled(on: boolean): void {
    this.config.update({ fullText: on });
    if (on) this.kick();
    else void this.stop();
  }

  /** Starts (or lets continue) the background pass over books that are not indexed yet. */
  kick(): void {
    if (!this.enabled || this.loop) return;
    this.stopping = false;
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.working = null;
    });
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private indexable(): BookRow[] {
    const seen = new Set<string>();
    return this.library.books().filter((b) => INDEXABLE.has(b.ext) && !seen.has(b.id) && seen.add(b.id));
  }

  private async run(): Promise<void> {
    await Bun.sleep(this.startDelayMs); // after start-up and the first scan, not during
    if (this.stopping || !this.enabled) return; // turned off, or the program is closing, while it waited
    const done = new Map((this.db.query("SELECT id, ver FROM docs").all() as { id: string; ver: number }[]).map((r) => [r.id, r.ver]));
    const todo = this.indexable().filter((b) => (done.get(b.id) ?? 0) < EXTRACTOR_VERSION);
    const touch = this.db.prepare("UPDATE docs SET seen = ? WHERE id = ?");
    const now = Date.now();
    for (const b of this.indexable()) if (done.has(b.id)) touch.run(now, b.id);
    for (const book of todo) {
      if (this.stopping || !this.enabled) return;
      await this.indexOne(book);
      await Bun.sleep(20);
    }
  }

  private async indexOne(book: BookRow): Promise<void> {
    const root = this.library.root;
    const extract = EXTRACTORS[book.ext];
    if (!root || !extract) return;
    this.working = book.name;
    const path = join(root, ...book.path.split("/"));
    const db = this.db;
    this.removeDoc(book.id);
    const first = ((db.query("SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks").get() as { m: number }).m ?? 0) + 1;
    db.run("INSERT INTO docs (id, state, ver, first, last, seen) VALUES (?, 'indexing', ?, ?, ?, ?)", [book.id, EXTRACTOR_VERSION, first, first - 1, Date.now()]);
    const insert = db.prepare("INSERT INTO chunks (text, id, loc) VALUES (?, ?, ?)");
    const flush = db.transaction((rows: [string, string][]) => rows.forEach(([text, loc]) => insert.run(text, book.id, loc)));
    let batch: [string, string][] = [];
    let count = 0;
    let state: "done" | "skipped" | "failed" = "done";
    let note: string | null = null;
    try {
      for await (const chunk of extract(path)) {
        batch.push([chunk.text, JSON.stringify(chunk.loc)]);
        count++;
        if (batch.length >= 200) {
          flush(batch);
          batch = [];
          if (this.stopping || !this.enabled) throw new NoText("stopped");
        }
      }
      flush(batch);
      if (!count) {
        state = "skipped";
        note = "no text";
      }
    } catch (err) {
      if (err instanceof NoText) {
        if (err.message === "stopped") {
          // interrupted by the administrator: leave nothing half-indexed, and try again next time
          db.run("DELETE FROM chunks WHERE rowid >= ?", [first]);
          db.run("DELETE FROM docs WHERE id = ?", [book.id]);
          return;
        }
        state = "skipped";
        note = err.message;
      } else {
        state = "failed";
        note = err instanceof Error ? err.message : String(err);
      }
    }
    const last = (db.query("SELECT COALESCE(MAX(rowid), 0) AS m FROM chunks").get() as { m: number }).m;
    db.run("UPDATE docs SET state = ?, last = ?, note = ? WHERE id = ?", [state, Math.max(last, first - 1), note, book.id]);
  }

  private removeDoc(id: string): void {
    const row = this.db.query("SELECT first, last FROM docs WHERE id = ?").get(id) as { first: number; last: number } | null;
    if (!row) return;
    if (row.last >= row.first) this.db.run("DELETE FROM chunks WHERE rowid BETWEEN ? AND ?", [row.first, row.last]);
    this.db.run("DELETE FROM docs WHERE id = ?", [id]);
  }

  /** After a scan: remember which books are still here, drop the index of books gone for a month, and index what is new. */
  onScan(olderThanMs = 30 * 24 * 3600 * 1000, now = Date.now()): void {
    const live = new Set(this.library.books().map((b) => b.id));
    for (const row of this.db.query("SELECT id, seen FROM docs").all() as { id: string; seen: number }[]) {
      if (!live.has(row.id) && now - row.seen > olderThanMs) this.removeDoc(row.id);
    }
    this.kick();
  }

  status(): FullTextStatus {
    const books = this.indexable();
    const ids = new Set(books.map((b) => b.id));
    const counts = { done: 0, skipped: 0, failed: 0 };
    for (const row of this.db.query("SELECT id, state FROM docs").all() as { id: string; state: string }[]) {
      if (ids.has(row.id) && row.state in counts) counts[row.state as keyof typeof counts]++;
    }
    const bytes = (this.db.query("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()").get() as { b: number }).b;
    const read = this.ocr.totals();
    return { enabled: this.enabled, total: ids.size, indexed: counts.done, skipped: counts.skipped, failed: counts.failed, working: this.working, bytes, recognizedBooks: read.books, recognizedPages: read.pages };
  }

  /** How far the background reading has got, for everybody who searches: books settled (read, or with nothing to read) of all that could have text. */
  progress(): { enabled: boolean; done: number; total: number } {
    const st = this.status();
    return { enabled: st.enabled, done: st.indexed + st.skipped + st.failed, total: st.total };
  }

  /** PDFs with nothing or next to nothing to read in them (no text at all, or under 2000 characters in the whole book), and how far their pictures have been read. */
  scans(): ScanBook[] {
    const ocr = this.ocr.all();
    const state = new Map((this.db.query("SELECT id, state, note, first, last FROM docs").all() as { id: string; state: string; note: string | null; first: number; last: number }[]).map((r) => [r.id, r]));
    const chars = this.db.prepare("SELECT COALESCE(SUM(length(text)), 0) AS n FROM chunks WHERE rowid BETWEEN ? AND ?");
    const out: ScanBook[] = [];
    for (const book of this.indexable()) {
      if (book.ext !== "pdf") continue;
      const doc = state.get(book.id);
      const progress = ocr.get(book.id) ?? null;
      const bare = doc?.state === "skipped" && doc.note === "no text";
      const sparse = doc?.state === "done" && (chars.get(doc.first, doc.last) as { n: number }).n < 2000;
      if (bare || sparse || progress) out.push({ book, ocr: progress });
    }
    return out;
  }

  /** Books whose text contains every word, best first; a few places per book (or all of them for one book). */
  search(q: string, options: SearchOptions = {}): FullTextBook[] {
    const query = matchQuery(q);
    if (!query || !this.enabled) return [];
    const perBook = Math.max(1, Math.min(options.perBook ?? PER_BOOK, MAX_PER_BOOK));
    const maxBooks = Math.max(1, Math.min(options.books ?? MAX_BOOKS, MAX_BOOKS_ASKED));
    const limit = options.book ? 400 : 600;
    const sql = `SELECT rowid, id, loc, snippet(chunks, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 16) AS snip, rank FROM chunks WHERE chunks MATCH ?${options.book ? " AND id = ?" : ""} ORDER BY rank LIMIT ${limit}`;
    const own = this.db.query(sql).all(...(options.book ? [query.match, options.book] : [query.match])) as { rowid: number; id: string; loc: string; snip: string; rank: number }[];
    // the pages read from pictures count beside the book's own text, the best first
    const rows = [...own.map((r) => ({ ...r, read: false })), ...this.ocr.rows(query.match, MARK_OPEN, MARK_CLOSE, options.book, limit).map((r) => ({ ...r, read: true }))].sort((a, b) => a.rank - b.rank).slice(0, limit);
    const byBook = new Map<string, FullTextBook>();
    for (const row of rows) {
      const book = this.library.byId(row.id);
      if (!book || (options.accept && !options.accept(row.id))) continue;
      let entry = byBook.get(row.id);
      if (!entry) {
        if (byBook.size >= maxBooks) continue;
        byBook.set(row.id, (entry = { id: row.id, hits: [], more: false }));
      }
      if (entry.hits.length >= perBook) {
        entry.more = true;
        continue;
      }
      const loc = JSON.parse(row.loc) as Loc;
      const view = viewFor(book.ext, loc, "offset" in loc && !row.read ? this.matchRange(row.rowid, loc.offset, query.words[0]!) : undefined);
      const share = "offset" in loc && !row.read ? this.shareOf(row.id, Number(view.offset)) : undefined;
      entry.hits.push({ snippet: row.snip.replace(/\s+/g, " ").trim(), loc, ...(share === undefined ? {} : { share }), view });
    }
    return [...byBook.values()];
  }

  /** How far into a text file a character offset lies, from where its last piece ends; nothing when the text is unknown or empty. */
  private shareOf(id: string, offset: number): number | undefined {
    const last = this.db.query("SELECT loc, length(text) AS n FROM chunks WHERE rowid = (SELECT last FROM docs WHERE id = ?)").get(id) as { loc: string; n: number } | null;
    const at = last ? (JSON.parse(last.loc) as Loc) : null;
    if (!last || !at || !("offset" in at)) return undefined;
    const total = at.offset + last.n;
    return total > 0 ? Math.round(Math.min(1, offset / total) * 1000) / 1000 : undefined;
  }

  /** Where in a plain-text file the first word occurs, so the reader can mark it. */
  private matchRange(rowid: number, chunkStart: number, word: string): { start: number; end: number } | undefined {
    const row = this.db.query("SELECT text FROM chunks WHERE rowid = ?").get(rowid) as { text: string } | null;
    const at = row?.text.toLowerCase().indexOf(word) ?? -1;
    return at < 0 || !row ? undefined : { start: chunkStart + at, end: chunkStart + at + word.length };
  }

  /** Throws the whole index away (and starts again if search is still on). */
  async clear(): Promise<void> {
    await this.stop();
    // emptied in place: deleting the database file fails on Windows, where an open file cannot be removed
    this.db.run("DROP TABLE IF EXISTS chunks");
    this.db.run("DROP TABLE IF EXISTS docs");
    this.db.run("VACUUM");
    this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    this.createTables(this.db);
    if (this.enabled) this.kick();
  }

  async close(): Promise<void> {
    await this.stop();
    this.db.close();
  }
}
