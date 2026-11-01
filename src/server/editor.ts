import { accessSync, constants, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, sep } from "node:path";
import type { Library } from "./library";

export type EditErrorCode = "no-library" | "invalid-name" | "exists" | "missing" | "into-itself" | "same-place" | "forbidden" | "read-only" | "failed";

export class EditError extends Error {
  constructor(readonly code: EditErrorCode) {
    super(code);
  }
}

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
