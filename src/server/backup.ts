import type { Database } from "bun:sqlite";
import { validateName } from "./auth";
import { MAX_LABEL, MAX_PER_USER, MAX_VIEW_BYTES } from "./bookmarks";
import { MAX_DISPLAY, parseDisplay, type Display } from "./display";
import { MAX_PROGRESS } from "./progress";
import { cleanText, cleanView, MAX_COMMENT, MAX_DESCRIPTION, MAX_ITEMS, MAX_PROJECTS, MAX_QUOTE, MAX_TITLE, ProjectError } from "./projects";
import type { Config, ConfigStore } from "./config";
import { cleanSourceName, cleanSourceUrl, MAX_SOURCES, SourceError } from "./sources";

/**
 * A backup of what cannot be rebuilt from the book folder: the accounts (with their password
 * hashes, never passwords), each reader's bookmarks and reading places, the share links and the server's settings.
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
  /** The saved sites books come from. Backups made before they existed have none, and restoring one leaves the saved sites as they are. */
  sources?: { name: string; url: string }[];
  /** Each reader's last place in books. Backups made before reading places existed have none, and restoring one leaves everybody with no places. */
  progress?: { user: string; bookId: string; view: unknown; label: string; updatedAt: number }[];
  /** How each reader likes to see books (turn of the pages, ...). Backups made before that existed have none, and restoring one leaves everybody with the default look. */
  display?: { user: string; bookId: string; display: Display; updatedAt: number }[];
  /** Each reader's projects with their items in order. Backups made before projects existed have none, and restoring one leaves everybody with no projects. */
  projects?: { user: string; title: string; description: string; createdAt: number; updatedAt: number; items: { bookId: string | null; view: unknown; title: string; comment: string; quote: string; createdAt: number }[] }[];
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

  let cleanSources: BackupFile["sources"];
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources) || raw.sources.length > MAX_SOURCES) bad();
    const urls = new Set<string>();
    cleanSources = (raw.sources as unknown[]).map((entry) => {
      if (!isObject(entry)) return bad();
      try {
        const clean = { name: cleanSourceName(entry.name), url: cleanSourceUrl(entry.url) };
        if (urls.has(clean.url)) bad();
        urls.add(clean.url);
        return clean;
      } catch (err) {
        if (err instanceof SourceError) return bad();
        throw err;
      }
    });
  }

  let cleanProgress: BackupFile["progress"];
  if (raw.progress !== undefined) {
    if (!Array.isArray(raw.progress) || raw.progress.length > MAX_USERS * MAX_PROGRESS) bad();
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    cleanProgress = (raw.progress as unknown[]).map((p) => {
      if (!isObject(p) || typeof p.user !== "string" || !names.has(p.user.toLowerCase()) || typeof p.bookId !== "string" || !BOOK_ID.test(p.bookId)) return bad();
      if ((p.view !== null && !isView(p.view)) || typeof p.label !== "string" || p.label.length > MAX_LABEL || !isTime(p.updatedAt)) return bad();
      const key = `${p.user.toLowerCase()}|${p.bookId}`;
      if (seen.has(key)) bad();
      seen.add(key);
      const count = (counts.get(p.user.toLowerCase()) ?? 0) + 1;
      if (count > MAX_PROGRESS) bad();
      counts.set(p.user.toLowerCase(), count);
      return { user: p.user, bookId: p.bookId, view: p.view, label: p.label, updatedAt: p.updatedAt };
    });
  }

  let cleanDisplay: BackupFile["display"];
  if (raw.display !== undefined) {
    if (!Array.isArray(raw.display) || raw.display.length > MAX_USERS * MAX_DISPLAY) bad();
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    cleanDisplay = (raw.display as unknown[]).map((d) => {
      if (!isObject(d) || typeof d.user !== "string" || !names.has(d.user.toLowerCase()) || typeof d.bookId !== "string" || !BOOK_ID.test(d.bookId) || !isTime(d.updatedAt)) return bad();
      const display = parseDisplay(d.display);
      if (!display) return bad();
      const key = `${d.user.toLowerCase()}|${d.bookId}`;
      if (seen.has(key)) bad();
      seen.add(key);
      const count = (counts.get(d.user.toLowerCase()) ?? 0) + 1;
      if (count > MAX_DISPLAY) bad();
      counts.set(d.user.toLowerCase(), count);
      return { user: d.user, bookId: d.bookId, display, updatedAt: d.updatedAt };
    });
  }

  let cleanProjects: BackupFile["projects"];
  if (raw.projects !== undefined) {
    if (!Array.isArray(raw.projects) || raw.projects.length > MAX_USERS * MAX_PROJECTS) bad();
    const counts = new Map<string, number>();
    try {
      cleanProjects = (raw.projects as unknown[]).map((p) => {
        if (!isObject(p) || typeof p.user !== "string" || !names.has(p.user.toLowerCase()) || !isTime(p.createdAt) || !isTime(p.updatedAt) || !Array.isArray(p.items) || p.items.length > MAX_ITEMS) return bad();
        const count = (counts.get(p.user.toLowerCase()) ?? 0) + 1;
        if (count > MAX_PROJECTS) bad();
        counts.set(p.user.toLowerCase(), count);
        const items = (p.items as unknown[]).map((i) => {
          if (!isObject(i) || !isTime(i.createdAt)) return bad();
          const bookId = i.bookId ?? null;
          if (bookId !== null && (typeof bookId !== "string" || !BOOK_ID.test(bookId))) bad();
          return {
            bookId: bookId as string | null,
            view: bookId === null ? null : cleanView(i.view),
            title: cleanText(i.title, MAX_TITLE, "title", true),
            comment: cleanText(i.comment, MAX_COMMENT, "comment"),
            quote: cleanText(i.quote, MAX_QUOTE, "quote"),
            createdAt: i.createdAt,
          };
        });
        return { user: p.user, title: cleanText(p.title, MAX_TITLE, "title", true), description: cleanText(p.description, MAX_DESCRIPTION, "description"), createdAt: p.createdAt, updatedAt: p.updatedAt, items };
      });
    } catch (err) {
      if (err instanceof ProjectError) bad(); // a text that does not fit the limits is not a backup this version can restore
      throw err;
    }
  }

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
    ...(cleanSources ? { sources: cleanSources } : {}),
    ...(cleanProgress ? { progress: cleanProgress } : {}),
    ...(cleanDisplay ? { display: cleanDisplay } : {}),
    ...(cleanProjects ? { projects: cleanProjects } : {}),
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
      sources: this.db.query("SELECT name, url FROM sources ORDER BY id").all() as { name: string; url: string }[],
      progress: (this.db.query("SELECT user_id AS userId, book_id AS bookId, view, label, updated_at AS updatedAt FROM progress ORDER BY updated_at").all() as { userId: number; bookId: string; view: string | null; label: string; updatedAt: number }[]).flatMap((p) =>
        nameOf.has(p.userId) ? [{ user: nameOf.get(p.userId)!, bookId: p.bookId, view: p.view === null ? null : JSON.parse(p.view), label: p.label, updatedAt: p.updatedAt }] : [],
      ),
      display: (this.db.query("SELECT user_id AS userId, book_id AS bookId, display, updated_at AS updatedAt FROM book_display ORDER BY updated_at").all() as { userId: number; bookId: string; display: string; updatedAt: number }[]).flatMap((d) =>
        nameOf.has(d.userId) ? [{ user: nameOf.get(d.userId)!, bookId: d.bookId, display: JSON.parse(d.display) as Display, updatedAt: d.updatedAt }] : [],
      ),
      projects: (this.db.query("SELECT id, user_id AS userId, title, description, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY id").all() as { id: number; userId: number; title: string; description: string; createdAt: number; updatedAt: number }[]).flatMap((p) =>
        nameOf.has(p.userId)
          ? [
              {
                user: nameOf.get(p.userId)!,
                title: p.title,
                description: p.description,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt,
                items: (this.db.query("SELECT book_id AS bookId, view, title, comment, quote, created_at AS createdAt FROM project_items WHERE project_id = ? ORDER BY position, id").all(p.id) as { bookId: string | null; view: string | null; title: string; comment: string; quote: string; createdAt: number }[]).map((i) => ({ ...i, view: i.view === null ? null : JSON.parse(i.view) })),
              },
            ]
          : [],
      ),
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
      this.db.run("DELETE FROM progress"); // goes with the users, whatever the backup holds
      this.db.run("DELETE FROM book_display");
      this.db.run("DELETE FROM projects"); // and their items; goes with the users, whatever the backup holds
      this.db.run("DELETE FROM users");
      const ids = new Map<string, number>();
      for (const u of file.users) {
        const row = this.db.query("INSERT INTO users (name, hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING id").get(u.name, u.hash, u.role, u.createdAt) as { id: number };
        ids.set(u.name.toLowerCase(), row.id);
      }
      for (const b of file.bookmarks) this.db.query("INSERT INTO bookmarks (user_id, book_id, label, view, created_at) VALUES (?, ?, ?, ?, ?)").run(ids.get(b.user.toLowerCase())!, b.bookId, b.label, JSON.stringify(b.view), b.createdAt);
      for (const p of file.progress ?? []) this.db.query("INSERT INTO progress (user_id, book_id, view, label, updated_at) VALUES (?, ?, ?, ?, ?)").run(ids.get(p.user.toLowerCase())!, p.bookId, p.view === null ? null : JSON.stringify(p.view), p.label, p.updatedAt);
      for (const d of file.display ?? []) this.db.query("INSERT INTO book_display (user_id, book_id, display, updated_at) VALUES (?, ?, ?, ?)").run(ids.get(d.user.toLowerCase())!, d.bookId, JSON.stringify(d.display), d.updatedAt);
      for (const p of file.projects ?? []) {
        const { id } = this.db.query("INSERT INTO projects (user_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id").get(ids.get(p.user.toLowerCase())!, p.title, p.description, p.createdAt, p.updatedAt) as { id: number };
        p.items.forEach((i, position) => this.db.query("INSERT INTO project_items (project_id, position, book_id, view, title, comment, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, position, i.bookId, i.view === null ? null : JSON.stringify(i.view), i.title, i.comment, i.quote, i.createdAt));
      }
      if (file.sources) {
        this.db.run("DELETE FROM sources");
        for (const source of file.sources) this.db.query("INSERT INTO sources (name, url, created_at) VALUES (?, ?, ?)").run(source.name, source.url, Date.now());
      }
      for (const s of file.shares) {
        this.db.query("INSERT INTO shares (token, book_id, view, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(s.token, s.bookId, s.view === null ? null : JSON.stringify(s.view), s.createdBy === null ? null : ids.get(s.createdBy.toLowerCase())!, s.createdAt, s.expiresAt);
      }
    })();
    return { users: file.users.length, bookmarks: file.bookmarks.length, shares: file.shares.length };
  }
}
