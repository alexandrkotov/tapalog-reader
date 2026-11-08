/** How a shelf is laid out and ordered, and which books it leaves out: the logic behind the bar above the shelf. */

export type ViewKind = "grid" | "list";
export type SortKey = "title" | "author" | "year" | "added" | "opened";
export const SORT_KEYS: SortKey[] = ["title", "author", "year", "added", "opened"];

export interface Prefs {
  view: ViewKind;
  sort: SortKey;
  /** Reversed order. */
  desc: boolean;
}

/** What a shelf keeps of the books: all of the conditions have to hold. An empty one lets everything through. */
export interface Filters {
  /** A format such as "pdf", or "". */
  format: string;
  /** A tag, lower-cased, or "". */
  tag: string;
  /** Part of an author's name, or "". */
  author: string;
}

export const NO_FILTERS: Filters = { format: "", tag: "", author: "" };
export const DEFAULT_PREFS: Prefs = { view: "grid", sort: "title", desc: false };

/** Newest first for the dates, a to z for the rest: what a reader expects when they pick the key. */
export const startsReversed = (key: SortKey): boolean => key === "added" || key === "opened";

export const isFiltering = (f: Filters): boolean => f.format !== "" || f.tag !== "" || f.author.trim() !== "";

/** What is read back from the browser's storage: anything else is the default. */
export function parsePrefs(raw: string | null): Prefs {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!data || typeof data !== "object") return DEFAULT_PREFS;
    const { view, sort, desc } = data as Record<string, unknown>;
    return {
      view: view === "list" ? "list" : "grid",
      sort: SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : "title",
      desc: desc === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export interface Sortable {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  added: number;
}

const text = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * The books in the order asked for. A book that lacks the value (no author, no year, never opened) goes last
 * whichever way the order runs, and equal books keep the order of their titles.
 */
export function sortBooks<T extends Sortable>(books: readonly T[], key: SortKey, desc: boolean, opened: ReadonlyMap<string, number> = new Map()): T[] {
  const value = (b: T): string | number | null => {
    switch (key) {
      case "title":
        return b.title;
      case "author":
        return b.authors[0]?.trim() || null;
      case "year":
        return b.year;
      case "added":
        return b.added;
      case "opened":
        return opened.get(b.id) ?? null;
    }
  };
  return [...books].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return x === y ? text(a.title, b.title) : x === null ? 1 : -1; // a missing value is last, in either direction
    const order = typeof x === "number" && typeof y === "number" ? x - y : text(String(x), String(y));
    return (desc ? -order : order) || text(a.title, b.title);
  });
}

export interface Filterable {
  ext: string;
  authors: string[];
  tags: string[];
}

export function filterBooks<T extends Filterable>(books: readonly T[], f: Filters): T[] {
  const author = f.author.trim().toLowerCase();
  return books.filter((b) => (!f.format || b.ext === f.format) && (!f.tag || b.tags.some((t) => t.toLowerCase() === f.tag)) && (!author || b.authors.some((a) => a.toLowerCase().includes(author))));
}

/** The formats present, most books first. */
export function formatsOf(books: readonly { ext: string }[]): { ext: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of books) counts.set(b.ext, (counts.get(b.ext) ?? 0) + 1);
  return [...counts].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}
