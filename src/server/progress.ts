import type { Database } from "bun:sqlite";
import { MAX_LABEL, MAX_VIEW_BYTES } from "./bookmarks";

export interface Progress {
  bookId: string;
  /** Where the reader was: the same JSON a bookmark or a share link carries, or null for a book that was opened but reports no place. */
  view: unknown;
  /** A short name of that place ("Page 12"), as the reader suggested when it was saved; may be empty. */
  label: string;
  updatedAt: number;
}

interface Row {
  book_id: string;
  view: string | null;
  label: string;
  updated_at: number;
}

/** How many books are remembered per reader; the least recently read go first. */
export const MAX_PROGRESS = 200;

const toProgress = (r: Row): Progress => ({ bookId: r.book_id, view: r.view === null ? null : JSON.parse(r.view), label: r.label, updatedAt: r.updated_at });

/**
 * Each reader's last place in each book, so a book opens where it was left (and the home page can offer
 * "continue reading"). Kept by content id, so a renamed or moved book keeps its place. Several tabs or
 * devices reading the same book simply overwrite each other: the last place saved is the one that stays.
 */
export class ProgressStore {
  constructor(private readonly db: Database) {}

  /** The reader's books, most recently read first. */
  recent(userId: number, limit = MAX_PROGRESS): Progress[] {
    return (this.db.query("SELECT book_id, view, label, updated_at FROM progress WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(userId, limit) as Row[]).map(toProgress);
  }

  get(userId: number, bookId: string): Progress | null {
    const row = this.db.query("SELECT book_id, view, label, updated_at FROM progress WHERE user_id = ? AND book_id = ?").get(userId, bookId) as Row | null;
    return row ? toProgress(row) : null;
  }

  /**
   * Notes that the book was read just now. With a `view` the place is replaced; without one (a book opened,
   * nothing scrolled yet) the earlier place stays. Throws "view too large".
   */
  save(userId: number, bookId: string, view?: unknown, label = "", now = Date.now()): void {
    const json = view === undefined || view === null ? null : JSON.stringify(view);
    if (json !== null && json.length > MAX_VIEW_BYTES) throw new Error("view too large");
    const text = label.trim().slice(0, MAX_LABEL);
    this.db.transaction(() => {
      if (json === null) {
        this.db.query("INSERT INTO progress (user_id, book_id, view, label, updated_at) VALUES (?, ?, NULL, '', ?) ON CONFLICT (user_id, book_id) DO UPDATE SET updated_at = excluded.updated_at").run(userId, bookId, now);
      } else {
        this.db.query("INSERT INTO progress (user_id, book_id, view, label, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, book_id) DO UPDATE SET view = excluded.view, label = excluded.label, updated_at = excluded.updated_at").run(userId, bookId, json, text, now);
      }
      this.db.query("DELETE FROM progress WHERE user_id = ? AND book_id NOT IN (SELECT book_id FROM progress WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(userId, userId, MAX_PROGRESS);
    })();
  }

  /** Forgets one book (the reader's own "remove from the list"). */
  remove(userId: number, bookId: string): boolean {
    return this.db.query("DELETE FROM progress WHERE user_id = ? AND book_id = ?").run(userId, bookId).changes > 0;
  }
}
