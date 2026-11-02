import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { fullHash } from "./duplicates";
import type { Library } from "./library";

export type EditErrorCode = "no-library" | "last-copy" | "invalid-name" | "exists" | "missing" | "into-itself" | "same-place" | "forbidden" | "read-only" | "failed";

export class EditError extends Error {
  constructor(readonly code: EditErrorCode) {
    super(code);
  }
}

/** Where books taken out as duplicates wait, inside the library folder. */
export const TRASH = ".tapalog-trash";

const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name that is valid as a file or folder name on Windows, macOS and Linux alike, so a library can move between them. */
export function validName(name: unknown): string {
  if (typeof name !== "string") throw new EditError("invalid-name");
  const n = name.trim();
  // A leading dot would hide it from the library; a trailing dot or space is not allowed on Windows.
  if (!n || n.length > 200 || BAD_CHARS.test(n) || n.startsWith(".") || /[. ]$/.test(n) || WINDOWS_RESERVED.test(n)) throw new EditError("invalid-name");
  return n;
}

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * Changes made to the library by the administrator: move and rename books and folders, make
 * folders. They are real changes to the files on disk, so every path must be one the library
 * already lists (nothing is built from raw request text), nothing is ever overwritten, and a
 * folder can't be moved into itself.
 */
export class LibraryEditor {
  constructor(
    private readonly library: Library,
    private readonly dataDir: string,
  ) {}

  /** Whether the library folder can be written to; edit mode is offered only then. */
  get writable(): boolean {
    const root = this.library.root;
    if (!root) return false;
    try {
      accessSync(root, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private abs(rel: string): string {
    return join(this.library.root!, ...rel.split("/"));
  }

  private known(kind: "book" | "folder", path: string): boolean {
    return kind === "book" ? this.library.bookAt(path) !== null : path !== "" && this.library.hasFolder(path);
  }

  /** Renaming or moving the folder that holds the app's own data would pull the database out from under it. */
  private guardData(kind: "book" | "folder", path: string): void {
    if (kind !== "folder") return;
    const here = this.abs(path);
    if (this.dataDir === here || this.dataDir.startsWith(here + sep)) throw new EditError("forbidden");
  }

  private run(kind: "book" | "folder", from: string, to: string): void {
    const taken = existsSync(this.abs(to)) && from.toLowerCase() !== to.toLowerCase(); // a change of letter case is the same file on a case-insensitive disk
    if (taken || (from !== to && this.library.bookAt(to))) throw new EditError("exists");
    try {
      renameSync(this.abs(from), this.abs(to));
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new EditError(code === "ENOENT" ? "missing" : code === "EACCES" || code === "EPERM" || code === "EROFS" ? "read-only" : code === "EEXIST" || code === "ENOTEMPTY" ? "exists" : "failed");
    }
    this.library.applyMove(kind, from, to);
    void this.library.rescan(); // the scan confirms what was just recorded
  }

  private check(kind: "book" | "folder", path: string): void {
    if (!this.library.root) throw new EditError("no-library");
    if (!this.known(kind, path)) throw new EditError("missing");
    this.guardData(kind, path);
  }

  move(kind: "book" | "folder", path: string, toFolder: string): void {
    this.check(kind, path);
    if (!this.library.hasFolder(toFolder)) throw new EditError("missing");
    if (dirOf(path) === toFolder) throw new EditError("same-place");
    if (kind === "folder" && (toFolder === path || toFolder.startsWith(`${path}/`))) throw new EditError("into-itself");
    this.run(kind, path, joinRel(toFolder, baseOf(path)));
  }

  /** A book keeps its extension (and so its format); only the name changes. */
  rename(kind: "book" | "folder", path: string, name: unknown): void {
    this.check(kind, path);
    const clean = validName(name);
    const file = baseOf(path);
    const ext = kind === "book" ? file.slice(file.lastIndexOf(".")) : "";
    const to = joinRel(dirOf(path), clean + ext);
    if (to === path) return;
    this.run(kind, path, to);
  }

  /**
   * Room for a new book in `folder`. The download goes to a hidden file beside its final place (the
   * scanner and the watcher skip those), so finishing is one rename on the same disk, and the final
   * name is checked now, before anything is fetched, and again when the file is put there.
   */
  reserve(folder: string, name: unknown, ext: string): { temp: string; commit(): string } {
    if (!this.library.root) throw new EditError("no-library");
    if (!this.library.hasFolder(folder)) throw new EditError("missing");
    const to = joinRel(folder, `${validName(name)}.${ext}`);
    const taken = () => existsSync(this.abs(to)) || this.library.bookAt(to) !== null;
    if (taken()) throw new EditError("exists");
    const temp = this.abs(joinRel(folder, `.${crypto.randomUUID().slice(0, 8)}.part`));
    return {
      temp,
      commit: () => {
        if (taken()) throw new EditError("exists");
        try {
          renameSync(temp, this.abs(to));
        } catch (err) {
          rmSync(temp, { force: true });
          const code = (err as { code?: string }).code;
          throw new EditError(code === "EACCES" || code === "EPERM" || code === "EROFS" ? "read-only" : "failed");
        }
        this.library.added();
        return to;
      },
    };
  }

  /**
   * Takes books out of the library into a hidden folder inside it, `.tapalog-trash` (on the same disk,
   * so it is one rename; the scanner skips it). Nothing is deleted: the files can be moved back by
   * hand. The last remaining copy of a book that exists more than once is never taken, so a mistake
   * can't make a book vanish: that is judged by reading the files whole, not by the library's quick id.
   * A book that has no identical twin can be taken, because then the administrator chose it as a
   * book whose name looked alike.
   */
  async trash(paths: string[]): Promise<number> {
    const root = this.library.root;
    if (!root) throw new EditError("no-library");
    const unique = [...new Set(paths)];
    const rows = unique.map((path) => this.library.bookAt(path));
    if (!unique.length || rows.some((row) => row === null)) throw new EditError("missing");
    const hashes = new Map<string, string | null>();
    const hashOf = async (path: string) => {
      if (!hashes.has(path)) hashes.set(path, await fullHash(this.abs(path)));
      return hashes.get(path)!;
    };
    for (const row of rows) {
      const candidates = this.library.pathsWithId(row!.id);
      if (candidates.length < 2) continue;
      const mine = await hashOf(row!.path);
      const identical: string[] = [];
      for (const path of candidates) if (mine !== null && (await hashOf(path)) === mine) identical.push(path);
      if (identical.length > 1 && identical.every((path) => unique.includes(path))) throw new EditError("last-copy");
    }
    const folder = join(root, TRASH);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const moved: string[] = [];
    try {
      mkdirSync(folder, { recursive: true });
      unique.forEach((path, i) => {
        const dot = path.lastIndexOf(".");
        const base = path.slice(0, dot).split("/").join(" - ").slice(0, 150); // the folder stays in the name, so the file can be put back
        const target = join(folder, `${stamp}-${i + 1} ${base}${path.slice(dot)}`);
        renameSync(this.abs(path), target);
        moved.push(path);
      });
    } catch (err) {
      if (moved.length) this.library.removed(moved);
      const code = (err as { code?: string }).code;
      throw new EditError(code === "ENOENT" ? "missing" : code === "EACCES" || code === "EPERM" || code === "EROFS" ? "read-only" : "failed");
    }
    this.library.removed(moved);
    return moved.length;
  }

  mkdir(parent: string, name: unknown): string {
    if (!this.library.root) throw new EditError("no-library");
    if (!this.library.hasFolder(parent)) throw new EditError("missing");
    const rel = joinRel(parent, validName(name));
    if (existsSync(this.abs(rel))) throw new EditError("exists");
    try {
      mkdirSync(this.abs(rel));
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new EditError(code === "EACCES" || code === "EPERM" || code === "EROFS" ? "read-only" : "failed");
    }
    this.library.addFolder(rel);
    return rel;
  }
}
