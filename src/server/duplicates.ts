import { join } from "node:path";
import type { BookFile, Library } from "./library";

export interface DuplicateGroup {
  items: BookFile[];
}

export interface Duplicates {
  /** Files with identical content, confirmed by reading them whole. */
  exact: DuplicateGroup[];
  /** Different files whose names are the same once case, punctuation and "copy" are ignored: possibly the same book. */
  similar: DuplicateGroup[];
}

const MAX_GROUPS = 500;

/** Reads the whole file, so identical means identical (the id the library keeps is only the size and the two ends). */
export async function fullHash(path: string): Promise<string | null> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
    return hasher.digest("hex");
  } catch {
    return null; // gone or unreadable since the scan
  }
}

/** The name with case, punctuation, accents and the words "copy"/"копия"/"копія" taken out. */
export function similarKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/(?<![\p{L}\p{N}])(copy|копия|копія)(?![\p{L}\p{N}])/gu, " ") // \b knows only Latin letters
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Looks for books stored twice. Nothing is changed; the administrator decides what to do with what is found. */
export async function findDuplicates(library: Library): Promise<Duplicates> {
  const root = library.root;
  const files = library.files();
  if (!root) return { exact: [], similar: [] };

  const byId = new Map<string, BookFile[]>();
  for (const file of files) byId.set(file.id, [...(byId.get(file.id) ?? []), file]);

  const exact: DuplicateGroup[] = [];
  for (const candidates of byId.values()) {
    if (candidates.length < 2) continue;
    const byHash = new Map<string, BookFile[]>();
    for (const file of candidates) {
      const hash = await fullHash(join(root, ...file.path.split("/")));
      if (hash) byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
    }
    for (const same of byHash.values()) if (same.length > 1) exact.push({ items: same });
  }

  const byKey = new Map<string, BookFile[]>();
  for (const file of files) {
    const key = similarKey(file.name);
    if (key.length >= 5) byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const similar: DuplicateGroup[] = [];
  for (const group of byKey.values()) {
    const contents = new Set(group.map((f) => f.id));
    if (group.length > 1 && contents.size > 1) similar.push({ items: group });
  }

  const order = (a: DuplicateGroup, b: DuplicateGroup) => a.items[0]!.path.localeCompare(b.items[0]!.path, undefined, { numeric: true });
  return { exact: exact.sort(order).slice(0, MAX_GROUPS), similar: similar.sort(order).slice(0, MAX_GROUPS) };
}
