import type { Database } from "bun:sqlite";
import { validateName } from "./auth";
import { MAX_LABEL, MAX_PER_USER, MAX_VIEW_BYTES } from "./bookmarks";
import type { Config, ConfigStore } from "./config";

/**
 * A backup of what cannot be rebuilt from the book folder: the accounts (with their password
 * hashes, never passwords), each reader's bookmarks, the share links and the server's settings.
 * Books, covers and the search index are not in it: a rescan and the background jobs make them again.
 * Sessions are not either, so after a restore everybody signs in again.
 */
export const BACKUP_FORMAT = "tapalog-reader-backup";
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  settings: Pick<Config, "lanAccess" | "allowRegistration" | "mode" | "fullText"> & { libraryPath: string | null };
  users: { name: string; hash: string; role: "admin" | "user"; createdAt: number }[];
  bookmarks: { user: string; bookId: string; label: string; view: unknown; createdAt: number }[];
  shares: { token: string; bookId: string; view: unknown; createdBy: string | null; createdAt: number; expiresAt: number | null }[];
}

export type BackupErrorCode = "not-backup" | "version" | "invalid" | "no-admin" | "too-big";

export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode) {
    super(code);
  }
}

const MAX_USERS = 5000;
const MAX_BOOKMARKS = 500_000;
const MAX_SHARES = 100_000;
const BOOK_ID = /^[0-9a-f]{20}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const HASH = /^\$argon2(id|i|d)\$[\x21-\x7e]{20,500}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isView = (v: unknown): boolean => isObject(v) && JSON.stringify(v).length <= MAX_VIEW_BYTES;

/** Throws a BackupError for anything that is not a backup this version can restore; nothing is changed by parsing. */
export function parseBackup(raw: unknown): BackupFile {
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) throw new BackupError("not-backup");
  if (raw.version !== BACKUP_VERSION) throw new BackupError("version");
  const { settings, users, bookmarks, shares } = raw;
  if (!isObject(settings) || !Array.isArray(users) || !Array.isArray(bookmarks) || !Array.isArray(shares)) throw new BackupError("invalid");
  if (users.length > MAX_USERS || bookmarks.length > MAX_BOOKMARKS || shares.length > MAX_SHARES) throw new BackupError("too-big");

  const bad = (): never => {
    throw new BackupError("invalid");
  };
  if (settings.lanAccess !== "open" && settings.lanAccess !== "login") bad();
  if (settings.mode !== "lan" && settings.mode !== "internet") bad();
  if (typeof settings.allowRegistration !== "boolean" || typeof settings.fullText !== "boolean") bad();

  const names = new Set<string>();
  const cleanUsers: BackupFile["users"] = users.map((u) => {
    const name = isObject(u) ? validateName(u.name) : null;
    if (!isObject(u) || !name || typeof u.hash !== "string" || !HASH.test(u.hash) || (u.role !== "admin" && u.role !== "user") || !isTime(u.createdAt)) return bad();
    if (names.has(name.toLowerCase())) bad(); // names are case-insensitive: two would collide
    names.add(name.toLowerCase());
    return { name, hash: u.hash, role: u.role, createdAt: u.createdAt };
  });
  if (!cleanUsers.some((u) => u.role === "admin")) throw new BackupError("no-admin");

  const perUser = new Map<string, number>();
  const cleanBookmarks: BackupFile["bookmarks"] = bookmarks.map((b) => {
    if (!isObject(b) || typeof b.user !== "string" || !names.has(b.user.toLowerCase()) || typeof b.bookId !== "string" || !BOOK_ID.test(b.bookId)) return bad();
    if (typeof b.label !== "string" || !b.label.trim() || b.label.length > MAX_LABEL || !isView(b.view) || !isTime(b.createdAt)) return bad();
    const key = b.user.toLowerCase();
    const count = (perUser.get(key) ?? 0) + 1;
    if (count > MAX_PER_USER) bad();
    perUser.set(key, count);
    return { user: b.user, bookId: b.bookId, label: b.label.trim(), view: b.view, createdAt: b.createdAt };
  });

  const tokens = new Set<string>();
  const cleanShares: BackupFile["shares"] = shares.map((s) => {
    if (!isObject(s) || typeof s.token !== "string" || !TOKEN.test(s.token) || tokens.has(s.token) || typeof s.bookId !== "string" || !BOOK_ID.test(s.bookId)) return bad();
    if (s.view !== null && !isView(s.view)) bad();
    if (s.createdBy !== null && (typeof s.createdBy !== "string" || !names.has(s.createdBy.toLowerCase()))) bad();
    if (!isTime(s.createdAt) || (s.expiresAt !== null && !isTime(s.expiresAt))) bad();
    tokens.add(s.token);
    return { token: s.token, bookId: s.bookId, view: s.view, createdBy: s.createdBy as string | null, createdAt: s.createdAt as number, expiresAt: s.expiresAt as number | null };
  });

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    settings: {
      lanAccess: settings.lanAccess as "open" | "login",
      allowRegistration: settings.allowRegistration as boolean,
      mode: settings.mode as "lan" | "internet",
      fullText: settings.fullText as boolean,
      libraryPath: typeof settings.libraryPath === "string" ? settings.libraryPath : null,
    },
    users: cleanUsers,
    bookmarks: cleanBookmarks,
    shares: cleanShares,
  };
}

export class Backup {
  constructor(
    private readonly db: Database,
    private readonly config: ConfigStore,
  ) {}

  create(now = new Date()): BackupFile {
    const c = this.config.get();
    const users = this.db.query("SELECT id, name, hash, role, created_at AS createdAt FROM users ORDER BY id").all() as { id: number; name: string; hash: string; role: "admin" | "user"; createdAt: number }[];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const bookmarks = this.db.query("SELECT user_id AS userId, book_id AS bookId, label, view, created_at AS createdAt FROM bookmarks ORDER BY id").all() as { userId: number; bookId: string; label: string; view: string; createdAt: number }[];
    const shares = this.db
      .query("SELECT token, book_id AS bookId, view, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt FROM shares WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at")
      .all(now.getTime()) as { token: string; bookId: string; view: string | null; createdBy: number | null; createdAt: number; expiresAt: number | null }[];
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      settings: { lanAccess: c.lanAccess, allowRegistration: c.allowRegistration, mode: c.mode, fullText: c.fullText, libraryPath: c.libraryPath },
      users: users.map(({ name, hash, role, createdAt }) => ({ name, hash, role, createdAt })),
      bookmarks: bookmarks.flatMap((b) => (nameOf.has(b.userId) ? [{ user: nameOf.get(b.userId)!, bookId: b.bookId, label: b.label, view: JSON.parse(b.view), createdAt: b.createdAt }] : [])),
      shares: shares.map((s) => ({ token: s.token, bookId: s.bookId, view: s.view ? JSON.parse(s.view) : null, createdBy: s.createdBy === null ? null : (nameOf.get(s.createdBy) ?? null), createdAt: s.createdAt, expiresAt: s.expiresAt })),
    };
  }

  /**
   * Replaces the accounts, bookmarks and share links with the backup's, all or nothing. Sessions are
   * dropped (every account is new). The settings are the caller's to apply, since some start or stop things.
   */
  restore(file: BackupFile): { users: number; bookmarks: number; shares: number } {
    this.db.transaction(() => {
      this.db.run("DELETE FROM sessions");
      this.db.run("DELETE FROM bookmarks");
      this.db.run("DELETE FROM shares");
      this.db.run("DELETE FROM users");
      const ids = new Map<string, number>();
      for (const u of file.users) {
        const row = this.db.query("INSERT INTO users (name, hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING id").get(u.name, u.hash, u.role, u.createdAt) as { id: number };
        ids.set(u.name.toLowerCase(), row.id);
      }
      for (const b of file.bookmarks) this.db.query("INSERT INTO bookmarks (user_id, book_id, label, view, created_at) VALUES (?, ?, ?, ?, ?)").run(ids.get(b.user.toLowerCase())!, b.bookId, b.label, JSON.stringify(b.view), b.createdAt);
      for (const s of file.shares) {
        this.db.query("INSERT INTO shares (token, book_id, view, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(s.token, s.bookId, s.view === null ? null : JSON.stringify(s.view), s.createdBy === null ? null : ids.get(s.createdBy.toLowerCase())!, s.createdAt, s.expiresAt);
      }
    })();
    return { users: file.users.length, bookmarks: file.bookmarks.length, shares: file.shares.length };
  }
}
