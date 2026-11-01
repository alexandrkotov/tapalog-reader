import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ConfigStore } from "./config";
import type { BookRow, Library } from "./library";
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
}

export interface FullTextHit {
  snippet: string;
  /** The reader's own view object, ready for `#book=…&view=…`. */
  view: Record<string, unknown>;
}

export interface FullTextBook {
  id: string;
  hits: FullTextHit[];
}

const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";
const MAX_BOOKS = 40;
const PER_BOOK = 3;

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
  }

  private open(): Database {
    const db = new Database(join(this.dataDir, "fulltext.db"), { create: true });
    db.run("PRAGMA journal_mode = WAL");
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
    return db;
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
    return { enabled: this.enabled, total: ids.size, indexed: counts.done, skipped: counts.skipped, failed: counts.failed, working: this.working, bytes };
  }

  /** Books whose text contains every word, best first; at most a few places per book. */
  search(q: string): FullTextBook[] {
    const query = matchQuery(q);
    if (!query || !this.enabled) return [];
    const rows = this.db
      .query(`SELECT rowid, id, loc, snippet(chunks, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 16) AS snip FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT 600`)
      .all(query.match) as { rowid: number; id: string; loc: string; snip: string }[];
    const byBook = new Map<string, FullTextBook>();
    for (const row of rows) {
      const book = this.library.byId(row.id);
      if (!book) continue;
      let entry = byBook.get(row.id);
      if (!entry) {
        if (byBook.size >= MAX_BOOKS) continue;
        byBook.set(row.id, (entry = { id: row.id, hits: [] }));
      }
      if (entry.hits.length >= PER_BOOK) continue;
      const loc = JSON.parse(row.loc) as Loc;
      entry.hits.push({ snippet: row.snip.replace(/\s+/g, " ").trim(), view: viewFor(book.ext, loc, "offset" in loc ? this.matchRange(row.rowid, loc.offset, query.words[0]!) : undefined) });
    }
    return [...byBook.values()];
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
    this.db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(this.dataDir, `fulltext.db${suffix}`), { force: true });
    this.db = this.open();
    if (this.enabled) this.kick();
  }

  async close(): Promise<void> {
    await this.stop();
    this.db.close();
  }
}
