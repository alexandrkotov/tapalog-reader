import type { Database } from "bun:sqlite";

export interface Share {
  token: string;
  bookId: string;
  view: unknown;
  createdBy: number | null;
  createdAt: number;
  expiresAt: number | null;
}

interface ShareRow {
  token: string;
  book_id: string;
  view: string | null;
  created_by: number | null;
  created_at: number;
  expires_at: number | null;
}

const MAX_VIEW_BYTES = 4096;

const toShare = (r: ShareRow): Share => ({
  token: r.token,
  bookId: r.book_id,
  view: r.view ? JSON.parse(r.view) : null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

/**
 * Links that open one book (optionally at one view) for anyone who has the
 * token — no account. The token is 128 random bits; the link stores only what
 * to open, so a short QR code carries a full "page + highlighted area" view.
 */
export class Shares {
  constructor(private readonly db: Database) {}

  create(bookId: string, view: unknown, createdBy: number | null, expiresInDays: number | null): Share {
    const json = view == null ? null : JSON.stringify(view);
    if (json && json.length > MAX_VIEW_BYTES) throw new Error("view too large");
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const now = Date.now();
    const expiresAt = expiresInDays ? now + expiresInDays * 86_400_000 : null;
    this.db.query("INSERT INTO shares (token, book_id, view, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(token, bookId, json, createdBy, now, expiresAt);
    return { token, bookId, view: view ?? null, createdBy, createdAt: now, expiresAt };
  }

  /** The share if it exists and hasn't expired. */
  get(token: string): Share | null {
    const row = this.db.query("SELECT * FROM shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)").get(token, Date.now()) as ShareRow | null;
    return row ? toShare(row) : null;
  }

  list(createdBy: number | "all"): (Share & { name: string | null; ext: string | null })[] {
    const where = createdBy === "all" ? "" : "WHERE s.created_by = ?";
    const rows = this.db
      .query(`SELECT s.*, (SELECT name FROM books WHERE id = s.book_id LIMIT 1) AS name, (SELECT ext FROM books WHERE id = s.book_id LIMIT 1) AS ext FROM shares s ${where} ORDER BY s.created_at DESC`)
      .all(...(createdBy === "all" ? [] : [createdBy])) as (ShareRow & { name: string | null; ext: string | null })[];
    return rows.map((r) => ({ ...toShare(r), name: r.name, ext: r.ext }));
  }

  /** Revokes a link. Non-admins may only revoke their own. */
  revoke(token: string, user: { id: number; role: string } | null): boolean {
    const row = this.db.query("SELECT created_by FROM shares WHERE token = ?").get(token) as { created_by: number | null } | null;
    if (!row) return false;
    if (user?.role !== "admin" && (user === null || row.created_by !== user.id)) return false;
    this.db.query("DELETE FROM shares WHERE token = ?").run(token);
    return true;
  }
}
