import type { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { formatOf } from "./formats";

const HASH_CHUNK = 64 * 1024;

/**
 * A book's id comes from its content (size + first and last 64 KiB), not its
 * path, so bookmarks and share links survive a rename or a move — whether done
 * in the app's edit mode or outside it.
 */
export async function contentId(absPath: string, size: number): Promise<string> {
  const file = Bun.file(absPath);
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(String(size));
  hasher.update(await file.slice(0, HASH_CHUNK).arrayBuffer());
  if (size > HASH_CHUNK) hasher.update(await file.slice(Math.max(HASH_CHUNK, size - HASH_CHUNK), size).arrayBuffer());
  return hasher.digest("hex").slice(0, 20);
}

interface Found {
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
}

export interface ScanResult {
  books: number;
  added: number;
  removed: number;
  ms: number;
}

async function walk(root: string, skipDirs: Set<string>): Promise<{ folders: string[]; files: Found[] }> {
  const folders: string[] = [];
  const files: Found[] = [];
  async function visit(rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it, the rest is still worth showing
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(root, childRel);
      if (entry.isDirectory()) {
        if (skipDirs.has(abs)) continue;
        folders.push(childRel);
        await visit(childRel);
      } else if (entry.isFile()) {
        const ext = formatOf(entry.name);
        if (!ext) continue;
        const info = await stat(abs).catch(() => null);
        if (!info) continue;
        const dot = entry.name.lastIndexOf(".");
        files.push({ path: childRel, name: entry.name.slice(0, dot), ext, size: info.size, mtime: Math.floor(info.mtimeMs) });
      }
    }
  }
  await visit("");
  return { folders, files };
}

/**
 * Brings the books table in line with the folder. Files whose size and mtime
 * didn't change keep their stored id without being read again, so a rescan of
 * ten thousand books is mostly stat calls. A scan reads the disk first and writes afterwards; if
 * `stale()` says something changed the tree meanwhile (an edit made by the app), its picture of the
 * disk is out of date and nothing is written: it returns null and the caller scans again.
 */
export async function scanLibrary(db: Database, root: string, skipDirs: string[] = [], stale: () => boolean = () => false): Promise<ScanResult | null> {
  const started = performance.now();
  const { folders, files } = await walk(root, new Set(skipDirs));

  const known = new Map<string, { id: string; size: number; mtime: number; added: number }>();
  for (const row of db.query("SELECT path, id, size, mtime, added FROM books").all() as { path: string; id: string; size: number; mtime: number; added: number }[]) {
    known.set(row.path, row);
  }
  const firstScan = known.size === 0;

  // "added" is not touched when a file changes; INSERT carries it for a new path
  const upsert = db.prepare(
    "INSERT INTO books (path, id, name, ext, size, mtime, added) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET id = excluded.id, name = excluded.name, ext = excluded.ext, size = excluded.size, mtime = excluded.mtime",
  );
  let added = 0;
  const changed: (Found & { id: string })[] = [];
  for (const file of files) {
    const old = known.get(file.path);
    if (old && old.size === file.size && old.mtime === file.mtime) continue;
    try {
      changed.push({ ...file, id: await contentId(join(root, file.path.split("/").join(sep)), file.size) });
    } catch {
      continue; // vanished or unreadable between the walk and the read
    }
    if (!old) added++;
  }

  const seen = new Set(files.map((f) => f.path));
  const gone = [...known.keys()].filter((p) => !seen.has(p));

  if (stale()) return null;
  // a file moved or renamed outside the app is "gone" at one path and new at another: it keeps the date it came
  const cameAt = new Map<string, number>();
  for (const p of gone) {
    const row = known.get(p)!;
    cameAt.set(row.id, Math.min(row.added, cameAt.get(row.id) ?? row.added));
  }
  const now = Date.now();
  db.transaction(() => {
    for (const f of changed) upsert.run(f.path, f.id, f.name, f.ext, f.size, f.mtime, known.get(f.path)?.added ?? cameAt.get(f.id) ?? (firstScan ? f.mtime : now));
    const del = db.prepare("DELETE FROM books WHERE path = ?");
    for (const p of gone) del.run(p);
    db.run("DELETE FROM folders");
    const insFolder = db.prepare("INSERT INTO folders (path) VALUES (?)");
    for (const f of folders) insFolder.run(f);
  })();

  return { books: files.length, added, removed: gone.length, ms: Math.round(performance.now() - started) };
}
