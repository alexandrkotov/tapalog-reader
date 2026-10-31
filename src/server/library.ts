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
  lastScan: ScanResult | null = null;
  private stopWatching: (() => void) | null = null;
  private rescanQueued = false;

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
      this.lastScan = await scanLibrary(this.db, root, [this.dataDir]);
      return this.lastScan;
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
