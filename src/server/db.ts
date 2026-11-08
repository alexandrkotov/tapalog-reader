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
    mtime INTEGER NOT NULL,
    added INTEGER NOT NULL DEFAULT 0 -- when the library first saw the file (ms); the file's own date for books found by the very first scan
  )`);
  // a database made before the "added" column: the file's own date is the best guess of when a book came
  if (!(db.query("PRAGMA table_info(books)").all() as { name: string }[]).some((c) => c.name === "added")) {
    db.run("ALTER TABLE books ADD COLUMN added INTEGER NOT NULL DEFAULT 0");
    db.run("UPDATE books SET added = mtime");
  }
  db.run("CREATE INDEX IF NOT EXISTS books_id ON books(id)");
  db.run("CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY)");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hash       TEXT NOT NULL,                 -- argon2id, see auth.ts
    role       TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,              -- sha256 of the cookie value: a leaked database can't be replayed
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS shares (
    token      TEXT PRIMARY KEY,              -- random, goes into the link
    book_id    TEXT NOT NULL,                 -- content id, so a moved or renamed book keeps its links
    view       TEXT,                          -- JSON view (page, position, highlighted area) or NULL
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER                        -- NULL = never
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    TEXT NOT NULL,                 -- content id, so a moved or renamed book keeps its bookmarks
    label      TEXT NOT NULL,
    view       TEXT NOT NULL,                 -- JSON view, the same shape the reader reports and a share link carries
    created_at INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS bookmarks_user ON bookmarks(user_id, book_id)");
  db.run(`CREATE TABLE IF NOT EXISTS progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    TEXT NOT NULL,                 -- content id, so a moved or renamed book keeps its place
    view       TEXT,                          -- JSON view the reader was at, or NULL when the book was only opened
    label      TEXT NOT NULL DEFAULT '',      -- a short name of that place, as the reader suggested it
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS progress_recent ON progress(user_id, updated_at)");
  db.run(`CREATE TABLE IF NOT EXISTS book_display (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    TEXT NOT NULL,                 -- content id, like progress
    display    TEXT NOT NULL,                 -- JSON settings of how the reader likes to see the book (turn, later crop)
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated_at)");
  db.run(`CREATE TABLE IF NOT EXISTS project_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,              -- the reader's order inside the project
    book_id    TEXT,                          -- content id, so a moved or renamed book keeps its place; NULL for a note of the reader's own
    view       TEXT,                          -- JSON view (page, position, marked area or passage) or NULL
    title      TEXT NOT NULL,
    comment    TEXT NOT NULL DEFAULT '',
    quote      TEXT NOT NULL DEFAULT '',      -- the passage, for text formats
    created_at INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS project_items_project ON project_items(project_id, position)");
  db.run(`CREATE TABLE IF NOT EXISTS book_meta (
    book_id    TEXT PRIMARY KEY,              -- content id, so a moved or renamed book keeps its card; the library's, not a reader's
    manual     TEXT NOT NULL DEFAULT '{}',    -- JSON of what the administrator typed (title, authors, year, series, description, language, tags); wins field by field
    auto       TEXT NOT NULL DEFAULT '{}',    -- JSON of what was read out of the file (see bookmeta.ts); can be made again
    auto_v     INTEGER NOT NULL DEFAULT 0,    -- the version of the reading that made \`auto\`; 0 = the file was not read yet
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sources (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL UNIQUE,          -- an http(s) address of a site books are taken from; only ever opened by the browser, never fetched by the server
    created_at INTEGER NOT NULL
  )`);
  return db;
}
