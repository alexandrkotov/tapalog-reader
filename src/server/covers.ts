import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BookRow } from "./library";

/** Formats that have a picture to show. TXT has none; DJVU has no decoder yet. */
export const COVER_FORMATS: ReadonlySet<string> = new Set(["pdf", "epub", "fb2", "mobi", "cbz", "ecatm"]);

export const MAX_COVER_BYTES = 400 * 1024;
const ID = /^[0-9a-f]{20}$/;

/**
 * Cover thumbnails, one JPEG per book content id (so a rename or move keeps it). They are
 * drawn by the administrator's browser and uploaded here: the server has no image decoder
 * and does not need one. A `.none` marker says "this book has no usable cover, don't try again".
 */
export class Covers {
  private readonly dir: string;
  private readonly have = new Set<string>();
  private readonly none = new Set<string>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "covers");
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      const id = name.slice(0, name.lastIndexOf("."));
      if (!ID.test(id)) continue;
      if (name.endsWith(".jpg")) this.have.add(id);
      else if (name.endsWith(".none")) this.none.add(id);
    }
  }

  has(id: string): boolean {
    return this.have.has(id);
  }

  file(id: string): string | null {
    return this.have.has(id) ? join(this.dir, `${id}.jpg`) : null;
  }

  /** Stores a JPEG. Returns false for anything that is not a plausible, small JPEG. */
  save(id: string, bytes: Uint8Array): boolean {
    if (!ID.test(id) || bytes.length < 100 || bytes.length > MAX_COVER_BYTES) return false;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false;
    writeFileSync(join(this.dir, `${id}.jpg`), bytes);
    this.have.add(id);
    if (this.none.delete(id)) rmSync(join(this.dir, `${id}.none`), { force: true });
    return true;
  }

  markNone(id: string): void {
    if (!ID.test(id) || this.have.has(id) || this.none.has(id)) return;
    writeFileSync(join(this.dir, `${id}.none`), "");
    this.none.add(id);
  }

  /** Books that could have a cover and have neither one nor a "none" marker; one per distinct content. */
  missing(books: readonly BookRow[], limit: number): { todo: BookRow[]; remaining: number } {
    const seen = new Set<string>();
    const todo: BookRow[] = [];
    let remaining = 0;
    for (const b of books) {
      if (!COVER_FORMATS.has(b.ext) || this.have.has(b.id) || this.none.has(b.id) || seen.has(b.id)) continue;
      seen.add(b.id);
      remaining++;
      if (todo.length < limit) todo.push(b);
    }
    return { todo, remaining };
  }

  /**
   * Drops covers of books that are gone. A cover is cheap to keep but costs the administrator's
   * browser real work to redraw, and a drive that is only briefly unplugged makes every book
   * look gone, so only covers of long-missing books are removed.
   */
  prune(liveIds: ReadonlySet<string>, olderThanMs = 30 * 24 * 3600 * 1000, now = Date.now()): number {
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const id = name.slice(0, name.lastIndexOf("."));
      if (!ID.test(id) || liveIds.has(id)) continue;
      const path = join(this.dir, name);
      if (!existsSync(path) || now - statSync(path).mtimeMs < olderThanMs) continue;
      rmSync(path, { force: true });
      this.have.delete(id);
      this.none.delete(id);
      removed++;
    }
    return removed;
  }
}
