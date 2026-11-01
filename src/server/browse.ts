import { existsSync, statSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { formatOf } from "./formats";

export interface Listing {
  /** Where this is; "" is the list of drives (Windows only). */
  path: string;
  /** The folder above, or null at the top; "" means the list of drives. */
  parent: string | null;
  sep: string;
  /** Shown as an example and as the place to start from. */
  home: string;
  dirs: string[];
  /** How many books lie directly in this folder. */
  books: number;
  truncated: boolean;
}

export class BrowseError extends Error {}

const MAX_ENTRIES = 3000;

/** Drive letters that answer within a second: a disconnected network drive must not hold the page up. */
async function drives(): Promise<string[]> {
  const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const answered = await Promise.all(
    letters.map((letter) =>
      Promise.race([access(`${letter}:${sep}`).then(() => `${letter}:${sep}`, () => null), Bun.sleep(1000).then(() => null)]),
    ),
  );
  return answered.filter((d): d is string => d !== null);
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folders inside `path`, for choosing the library folder from the page. Only names of folders
 * are listed (never files), hidden ones are left out, and `path` must be an absolute path that exists.
 */
export async function browse(path: string | null): Promise<Listing> {
  const home = homedir();
  const base = { sep, home, truncated: false };
  if (process.platform === "win32" && path === "") return { ...base, path: "", parent: null, dirs: await drives(), books: 0 };
  const where = path ? path : isDir(home) ? home : parse(home).root;
  if (!isAbsolute(where) || !existsSync(where) || !isDir(where)) throw new BrowseError("not a folder");
  const abs = resolve(where);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    throw new BrowseError("not readable");
  }
  const dirs: string[] = [];
  let books = 0;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) {
      if (formatOf(entry.name)) books++;
    } else if (entry.isDirectory() || (entry.isSymbolicLink() && isDir(join(abs, entry.name)))) {
      dirs.push(entry.name);
    }
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const up = dirname(abs);
  const parent = up !== abs ? up : process.platform === "win32" ? "" : null;
  return { ...base, path: abs, parent, dirs: dirs.slice(0, MAX_ENTRIES), books, truncated: dirs.length > MAX_ENTRIES };
}
