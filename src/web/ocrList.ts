/** What the window for recognizing scans needs of a book to filter and order the list (no DOM here, so it can be tested). */
export interface OcrListRow {
  id: string;
  title: string;
  path: string;
  size: number;
  /** Null until the recognition of the book has begun: only then is the number of pages known. */
  pages: number | null;
  done: number;
}

/** "unread": not finished (not begun, or stopped half way). */
export type OcrShow = "all" | "unread" | "partial" | "done";
export type OcrSort = "path" | "title" | "unread" | "size";

export const OCR_SHOWS: readonly OcrShow[] = ["all", "unread", "partial", "done"];
export const OCR_SORTS: readonly OcrSort[] = ["path", "title", "unread", "size"];

export type OcrState = "new" | "partial" | "done";

export function stateOf(row: OcrListRow): OcrState {
  if (row.done === 0 || row.pages === null) return "new";
  return row.done >= row.pages ? "done" : "partial";
}

/** Not recognized to the end: what "Select the unrecognized" ticks. */
export const isUnread = (row: OcrListRow): boolean => stateOf(row) !== "done";

/** The words of a search box: lower case, no empty ones. */
export function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The books that match every word of the query (in the title or the path) and the chosen state. */
export function filterRows<T extends OcrListRow>(rows: readonly T[], query: string, show: OcrShow): T[] {
  const words = wordsOf(query);
  return rows.filter((row) => {
    const state = stateOf(row);
    if (show === "unread" ? state === "done" : show !== "all" && state !== show) return false;
    if (!words.length) return true;
    const hay = `${row.title}\n${row.path}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const collate = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const RANK: Record<OcrState, number> = { new: 0, partial: 1, done: 2 };

/** A sorted copy: by folder and name, by title, the unrecognized first (then half done, then done), or the biggest files first. Ties fall back to the path, so the order is always the same. */
export function sortRows<T extends OcrListRow>(rows: readonly T[], sort: OcrSort): T[] {
  const byPath = (a: T, b: T) => collate.compare(a.path, b.path);
  const compare: Record<OcrSort, (a: T, b: T) => number> = {
    path: byPath,
    title: (a, b) => collate.compare(a.title, b.title) || byPath(a, b),
    unread: (a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || byPath(a, b),
    size: (a, b) => b.size - a.size || byPath(a, b),
  };
  return [...rows].sort(compare[sort]);
}
