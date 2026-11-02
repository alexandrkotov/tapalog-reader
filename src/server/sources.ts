import type { Database } from "bun:sqlite";

export interface Source {
  id: number;
  name: string;
  url: string;
}

export type SourceErrorCode = "invalid-name" | "bad-link" | "exists" | "too-many";

export class SourceError extends Error {
  constructor(readonly code: SourceErrorCode) {
    super(code);
  }
}

export const MAX_SOURCES = 200;
const MAX_NAME = 100;
const MAX_URL = 2000;

/** An http(s) address without a password in it, in the form the browser would write it; anything else is refused. */
export function cleanSourceUrl(text: unknown): string {
  if (typeof text !== "string" || text.length > MAX_URL) throw new SourceError("bad-link");
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new SourceError("bad-link");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) throw new SourceError("bad-link");
  return url.href;
}

export function cleanSourceName(text: unknown): string {
  const name = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_NAME) throw new SourceError("invalid-name");
  return name;
}

/**
 * The sites the administrator takes books from, kept so they are at hand in the download dialog.
 * They are only links for a person to click: the server never requests them.
 */
export class Sources {
  constructor(private readonly db: Database) {}

  list(): Source[] {
    return this.db.query("SELECT id, name, url FROM sources ORDER BY name COLLATE NOCASE, id").all() as Source[];
  }

  add(name: unknown, url: unknown): Source {
    const clean = { name: cleanSourceName(name), url: cleanSourceUrl(url) };
    if (this.list().length >= MAX_SOURCES) throw new SourceError("too-many");
    if (this.db.query("SELECT 1 FROM sources WHERE url = ?").get(clean.url)) throw new SourceError("exists");
    const { lastInsertRowid } = this.db.query("INSERT INTO sources (name, url, created_at) VALUES (?, ?, ?)").run(clean.name, clean.url, Date.now());
    return { id: Number(lastInsertRowid), ...clean };
  }

  remove(id: number): boolean {
    return this.db.query("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
  }
}
