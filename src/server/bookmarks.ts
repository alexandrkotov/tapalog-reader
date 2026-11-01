import type { Database } from "bun:sqlite";

export interface Bookmark {
  id: number;
  bookId: string;
  label: string;
  view: unknown;
  createdAt: number;
}

interface Row {
  id: number;
  book_id: string;
  label: string;
  view: string;
  created_at: number;
}

export const MAX_VIEW_BYTES = 4096;
export const MAX_LABEL = 200;
export const MAX_PER_USER = 2000;

const toBookmark = (r: Row): Bookmark => ({ id: r.id, bookId: r.book_id, label: r.label, view: JSON.parse(r.view), createdAt: r.created_at });

/** A reader's own places in books: a name and the view (page, position, marked area) to return to. */
export class Bookmarks {
  constructor(private readonly db: Database) {}

  list(userId: number, bookId?: string): Bookmark[] {
    const rows = bookId
      ? this.db.query("SELECT id, book_id, label, view, created_at FROM bookmarks WHERE user_id = ? AND book_id = ? ORDER BY created_at DESC, id DESC").all(userId, bookId)
      : this.db.query("SELECT id, book_id, label, view, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC, id DESC").all(userId);
    return (rows as Row[]).map(toBookmark);
  }

  /** Throws "too many" or "view too large"; the label is trimmed and must not be empty. */
  add(userId: number, bookId: string, label: string, view: unknown): Bookmark {
    const text = label.trim().slice(0, MAX_LABEL);
    const json = JSON.stringify(view);
    if (!text) throw new Error("label required");
    if (json.length > MAX_VIEW_BYTES) throw new Error("view too large");
    if ((this.db.query("SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?").get(userId) as { n: number }).n >= MAX_PER_USER) throw new Error("too many");
    const now = Date.now();
    const { lastInsertRowid } = this.db.query("INSERT INTO bookmarks (user_id, book_id, label, view, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, bookId, text, json, now);
    return { id: Number(lastInsertRowid), bookId, label: text, view, createdAt: now };
  }

  /** Only the owner's own bookmark can be removed. */
  remove(userId: number, id: number): boolean {
    return this.db.query("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  rename(userId: number, id: number, label: string): boolean {
    const text = label.trim().slice(0, MAX_LABEL);
    return !!text && this.db.query("UPDATE bookmarks SET label = ? WHERE id = ? AND user_id = ?").run(text, id, userId).changes > 0;
  }
}
