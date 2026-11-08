import type { Database } from "bun:sqlite";
import type { Config, ConfigStore } from "./config";
import { scanLibrary, type ScanResult } from "./scanner";
import { watchLibrary } from "./watcher";
import { BookMeta, extractMeta, META_FORMATS, searchText } from "./bookmeta";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BookRow {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
}

export interface BookFile extends BookRow {
  mtime: number;
  /** When the library first saw the file (ms since 1970). */
  added: number;
}

/** A book as the shelf lists it. */
export interface ShelfBook extends BookRow {
  added: number;
}

/** Owns the scan state of the one configured library folder and keeps it fresh. */
export class Library {
  scanning = false;
  /** Called after every finished scan. */
  onScan: (() => void) | null = null;
  lastScan: ScanResult | null = null;
  private stopWatching: (() => void) | null = null;
  private rescanQueued = false;
  private closed = false;
  /** Counts edits the app made itself; a scan that began before one must not write its (now wrong) result. */
  private edits = 0;
  /** What the library knows about each book besides its file: see bookmeta.ts. */
  readonly meta: BookMeta;
  private filling: Promise<number> | null = null;
  private refill = false;

  constructor(
    private readonly db: Database,
    private readonly config: ConfigStore,
    private readonly dataDir: string,
  ) {
    this.meta = new BookMeta(db);
  }

  get root(): string | null {
    return this.config.get().libraryPath;
  }

  /** Validates and stores a new library folder, then scans it. */
  async setRoot(path: string): Promise<void> {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error("not a folder");
    this.config.update({ libraryPath: abs });
    this.db.run("DELETE FROM books");
    this.db.run("DELETE FROM folders");
    await this.start();
  }

  /** Stops watching the folder (a watched folder cannot be deleted on Windows). */
  close(): void {
    this.closed = true; // a scan still running may find its database closed: that is not an error then
    this.stopWatching?.();
    this.stopWatching = null;
  }

  /** Scans now and begins watching for changes. */
  async start(): Promise<void> {
    this.closed = false;
    this.stopWatching?.();
    this.stopWatching = null;
    const root = this.root;
    if (!root) return;
    await this.rescan();
    this.stopWatching = watchLibrary(root, () => void this.rescan());
  }

  async rescan(): Promise<ScanResult | null> {
    const root = this.root;
    if (!root) return null;
    if (this.scanning) {
      this.rescanQueued = true; // something changed mid-scan: run once more after it
      return null;
    }
    this.scanning = true;
    try {
      const edits = this.edits;
      const result = await scanLibrary(this.db, root, [this.dataDir], () => this.edits !== edits);
      if (!result) {
        this.rescanQueued = true; // an edit landed while the disk was being read: read it again
        return null;
      }
      this.lastScan = result;
      this.onScan?.();
      void this.fillMeta().catch(() => {}); // reading the files for titles and authors goes on after the list is out
      return result;
    } catch (err) {
      if (this.closed) return null;
      throw err;
    } finally {
      this.scanning = false;
      if (this.rescanQueued && !this.closed) {
        this.rescanQueued = false;
        void this.rescan();
      }
    }
  }

  folders(): string[] {
    return (this.db.query("SELECT path FROM folders ORDER BY path").all() as { path: string }[]).map((r) => r.path);
  }

  books(): ShelfBook[] {
    return this.db.query("SELECT id, path, name, ext, size, added FROM books ORDER BY path").all() as ShelfBook[];
  }

  /** Every book with the time its file was last changed, for finding duplicates. */
  files(): BookFile[] {
    return this.db.query("SELECT id, path, name, ext, size, mtime, added FROM books ORDER BY path").all() as BookFile[];
  }

  /** The paths of all books with this content id: more than one means identical files. */
  pathsWithId(id: string): string[] {
    return (this.db.query("SELECT path FROM books WHERE id = ? ORDER BY path").all(id) as { path: string }[]).map((r) => r.path);
  }

  byId(id: string): BookRow | null {
    return (this.db.query("SELECT id, path, name, ext, size FROM books WHERE id = ? LIMIT 1").get(id) as BookRow | null) ?? null;
  }

  hasFolder(path: string): boolean {
    return path === "" || this.db.query("SELECT 1 FROM folders WHERE path = ?").get(path) !== null;
  }

  bookAt(path: string): BookRow | null {
    return (this.db.query("SELECT id, path, name, ext, size FROM books WHERE path = ?").get(path) as BookRow | null) ?? null;
  }

  /**
   * Records a rename or move the app has just made on disk, so the tree is right at once instead
   * of after the next scan. A folder takes everything under it along. Ids don't change: they come
   * from content.
   */
  applyMove(kind: "book" | "folder", from: string, to: string): void {
    this.edits++;
    const escape = (p: string) => p.replace(/[\\%_]/g, (c) => `\\${c}`);
    this.db.transaction(() => {
      if (kind === "book") {
        const name = to.slice(to.lastIndexOf("/") + 1);
        this.db.run("UPDATE books SET path = ?, name = ? WHERE path = ?", [to, name.slice(0, name.lastIndexOf(".")), from]);
        return;
      }
      const cut = from.length + 1;
      this.db.run("UPDATE books SET path = ? || substr(path, ?) WHERE path LIKE ? ESCAPE '\\'", [to, cut, `${escape(from)}/%`]);
      this.db.run("UPDATE folders SET path = ? || substr(path, ?) WHERE path = ? OR path LIKE ? ESCAPE '\\'", [to, cut, from, `${escape(from)}/%`]);
    })();
  }

  /** Books the app has just taken out of the library (to the trash): gone from the list at once, the scan confirms it. */
  removed(paths: string[]): void {
    this.edits++;
    this.db.transaction(() => {
      for (const path of paths) this.db.run("DELETE FROM books WHERE path = ?", [path]);
    })();
    void this.rescan();
  }

  /** A book was put into the folder by the app: scan again (and not trust a scan that began before it). */
  added(): void {
    this.edits++;
    void this.rescan();
  }

  addFolder(path: string): void {
    this.edits++;
    this.db.run("INSERT OR IGNORE INTO folders (path) VALUES (?)", [path]);
  }

  /**
   * Reads the files whose metadata has not been read yet (EPUB and FB2), one at a time, giving way to the server
   * between files. Asking again while it runs makes it look once more when it is done, and waits for that.
   */
  fillMeta(): Promise<number> {
    if (this.filling) {
      this.refill = true;
      return this.filling;
    }
    const run = async (): Promise<number> => {
      let done = 0;
      try {
        do {
          this.refill = false;
          const root = this.root;
          if (!root) break;
          const seen = new Set<string>();
          const todo = this.db.query("SELECT id, path, ext FROM books ORDER BY path").all() as { id: string; path: string; ext: string }[];
          for (const book of todo) {
            if (this.closed) return done;
            if (!META_FORMATS.has(book.ext) || seen.has(book.id) || !this.meta.needsAuto(book.id)) continue;
            seen.add(book.id);
            const auto = await extractMeta(join(root, ...book.path.split("/")), book.ext).catch(() => ({})); // not what it says it is: nothing to learn from it
            if (this.closed) return done;
            this.meta.setAuto(book.id, auto);
            if (++done % 20 === 0) await Bun.sleep(0);
          }
        } while (this.refill && !this.closed);
      } catch (err) {
        if (!this.closed) throw err; // a database closed under a running read is not an error
      } finally {
        this.filling = null;
      }
      return done;
    };
    this.filling = run();
    return this.filling;
  }

  /** Any occurrence of the query in a file name, its folder path, or the book's title, authors, series or tags, case-insensitively. */
  searchNames(query: string, limit = 50): BookRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const meta = this.meta.all();
    const found: BookRow[] = [];
    for (const book of this.db.query("SELECT id, path, name, ext, size FROM books ORDER BY name").all() as BookRow[]) {
      if (book.path.toLowerCase().includes(q) || searchText(meta.get(book.id)).includes(q)) found.push(book);
      if (found.length >= limit) break;
    }
    return found;
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n;
  }

  settings(): Config {
    return this.config.get();
  }
}
