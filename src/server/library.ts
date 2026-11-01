import type { Database } from "bun:sqlite";
import type { Config, ConfigStore } from "./config";
import { scanLibrary, type ScanResult } from "./scanner";
import { watchLibrary } from "./watcher";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface BookRow {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
}

/** Owns the scan state of the one configured library folder and keeps it fresh. */
export class Library {
  scanning = false;
  /** Called after every finished scan. */
  onScan: (() => void) | null = null;
  lastScan: ScanResult | null = null;
  private stopWatching: (() => void) | null = null;
  private rescanQueued = false;
  /** Counts edits the app made itself; a scan that began before one must not write its (now wrong) result. */
  private edits = 0;

  constructor(
    private readonly db: Database,
    private readonly config: ConfigStore,
    private readonly dataDir: string,
  ) {}

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
    this.stopWatching?.();
    this.stopWatching = null;
  }

  /** Scans now and begins watching for changes. */
  async start(): Promise<void> {
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
      return result;
    } finally {
      this.scanning = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.rescan();
      }
    }
  }

  folders(): string[] {
    return (this.db.query("SELECT path FROM folders ORDER BY path").all() as { path: string }[]).map((r) => r.path);
  }

  books(): BookRow[] {
    return this.db.query("SELECT id, path, name, ext, size FROM books ORDER BY path").all() as BookRow[];
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

  addFolder(path: string): void {
    this.edits++;
    this.db.run("INSERT OR IGNORE INTO folders (path) VALUES (?)", [path]);
  }

  /** Any occurrence of the query in a file name or its folder path, case-insensitively. */
  searchNames(query: string, limit = 50): BookRow[] {
    const q = query.trim();
    if (!q) return [];
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .query("SELECT id, path, name, ext, size FROM books WHERE path LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?")
      .all(pattern, limit) as BookRow[];
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n;
  }

  settings(): Config {
    return this.config.get();
  }
}
