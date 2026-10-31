import { Database } from "bun:sqlite";
import { join } from "node:path";

/**
 * The app's own database: a cache of what is on disk plus (later) users,
 * bookmarks and share links. The folder on disk stays the source of truth for
 * books — a book row can always be rebuilt by rescanning.
 */
export function openDb(dataDir: string): Database {
  const db = new Database(join(dataDir, "library.db"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS books (
    path  TEXT PRIMARY KEY,   -- relative to the library folder, "/" separated
    id    TEXT NOT NULL,      -- content id (see scanner.ts); equal for identical files
    name  TEXT NOT NULL,      -- file name without extension
    ext   TEXT NOT NULL,      -- normalized format: pdf, epub, ecatm, ...
    size  INTEGER NOT NULL,
    mtime INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS books_id ON books(id)");
  db.run("CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY)");
  return db;
}
