import type { Database } from "bun:sqlite";

/** A rectangle of a page as fractions (0..1) of its width and height, in the page as the file has it (before any turn). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which part of the pages is shown. `all` is for every page; `odd` and `even` (by page number, 1 is odd)
 * replace it for those pages, because a book scanned two pages at a time has its margins mirrored.
 */
export interface Crop {
  all?: CropRect;
  odd?: CropRect;
  even?: CropRect;
}

/**
 * How a reader likes to see one book: settings of the view, not of the file, which is never touched.
 */
export interface Display {
  /** Clockwise turn of every page, in degrees; left out when the pages are as the file has them. */
  rotation?: 90 | 180 | 270;
  /** The part of the pages that is shown; left out when the pages are whole. */
  crop?: Crop;
  /**
   * How many pages of the file come before the book's printed page 1, so printed number = file page - pageOffset
   * (cover and front matter make it positive; a scan that starts in the middle of the book makes it negative).
   * Left out when the printed numbers are the file's.
   */
  pageOffset?: number;
}

/** The largest offset accepted either way: more than any real book has front matter. */
export const MAX_PAGE_OFFSET = 9999;

/** The smallest side of a crop, as a fraction of the page: a sliver is a slip of the hand, not a margin. */
export const MIN_CROP = 0.05;
const round = (n: number) => Math.round(n * 10000) / 10000;

/** A valid crop rectangle, tidied, `"whole"` for one that covers the whole page, or null for nonsense. */
function parseCropRect(value: unknown): CropRect | "whole" | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const [x, y, w, h] = [r.x, r.y, r.w, r.h];
  if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") return null;
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < MIN_CROP || h < MIN_CROP || x + w > 1.0001 || y + h > 1.0001) return null;
  const out = { x: round(x), y: round(y), w: round(Math.min(w, 1 - x)), h: round(Math.min(h, 1 - y)) };
  return out.x === 0 && out.y === 0 && out.w === 1 && out.h === 1 ? "whole" : out;
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
  if (raw.pageOffset !== undefined) {
    if (typeof raw.pageOffset !== "number" || !Number.isInteger(raw.pageOffset) || Math.abs(raw.pageOffset) > MAX_PAGE_OFFSET) return null;
    if (raw.pageOffset !== 0) out.pageOffset = raw.pageOffset;
  }
  if (raw.crop !== undefined) {
    if (typeof raw.crop !== "object" || raw.crop === null || Array.isArray(raw.crop)) return null;
    const crop: Crop = {};
    for (const key of ["all", "odd", "even"] as const) {
      const given = (raw.crop as Record<string, unknown>)[key];
      if (given === undefined) continue;
      const rect = parseCropRect(given);
      if (rect === null) return null;
      if (rect !== "whole") crop[key] = rect; // a crop of the whole page changes nothing and is not kept
    }
    if (Object.keys(crop).length) out.crop = crop;
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
