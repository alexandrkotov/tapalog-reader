import type { Database } from "bun:sqlite";

/**
 * How a reader likes to see one book: settings of the view, not of the file, which is never touched.
 * Today the turn of the pages; the crop of the margins is added to this shape later.
 */
export interface Display {
  /** Clockwise turn of every page, in degrees; left out when the pages are as the file has them. */
  rotation?: 90 | 180 | 270;
}

/** How many books keep display settings per reader; the least recently changed go first. */
export const MAX_DISPLAY = 500;

/**
 * Checks and tidies settings that came from outside. Returns null for anything that is not settings,
 * and `{}` for settings that change nothing (which are not worth keeping). Unknown fields are dropped.
 */
export function parseDisplay(value: unknown): Display | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: Display = {};
  if (raw.rotation !== undefined) {
    if (raw.rotation !== 0 && raw.rotation !== 90 && raw.rotation !== 180 && raw.rotation !== 270) return null;
    if (raw.rotation !== 0) out.rotation = raw.rotation;
  }
  return out;
}

export const isDefaultDisplay = (d: Display): boolean => Object.keys(d).length === 0;

/**
 * Each reader's display settings per book, by content id so a renamed or moved book keeps them.
 * Settings that change nothing are not stored: saving them removes what was there.
 */
export class DisplayStore {
  constructor(private readonly db: Database) {}

  get(userId: number, bookId: string): Display | null {
    const row = this.db.query("SELECT display FROM book_display WHERE user_id = ? AND book_id = ?").get(userId, bookId) as { display: string } | null;
    return row ? (parseDisplay(JSON.parse(row.display)) ?? null) : null;
  }

  save(userId: number, bookId: string, display: Display, now = Date.now()): void {
    this.db.transaction(() => {
      if (isDefaultDisplay(display)) {
        this.db.query("DELETE FROM book_display WHERE user_id = ? AND book_id = ?").run(userId, bookId);
        return;
      }
      this.db.query("INSERT INTO book_display (user_id, book_id, display, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, book_id) DO UPDATE SET display = excluded.display, updated_at = excluded.updated_at").run(userId, bookId, JSON.stringify(display), now);
      this.db.query("DELETE FROM book_display WHERE user_id = ? AND book_id NOT IN (SELECT book_id FROM book_display WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)").run(userId, userId, MAX_DISPLAY);
    })();
  }
}
