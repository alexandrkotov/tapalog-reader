import { store } from "./ui";

/** A rectangle of a page as fractions of its width and height, in the page as the file has it (before any turn). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which part of the pages is shown: `all`, or `odd` / `even` pages (by page number) in place of it. */
export interface Crop {
  all?: CropRect;
  odd?: CropRect;
  even?: CropRect;
}

/** How a reader likes to see one book (never a change to the file). Mirrors the server's `Display`. */
export interface Display {
  rotation?: 90 | 180 | 270;
  crop?: Crop;
  /** Pages of the file before the book's printed page 1: printed number = file page - pageOffset. */
  pageOffset?: number;
}

/**
 * A signed-in reader's settings live on the server and follow the account; a guest's live in this browser
 * only and never move to an account, like reading places.
 */
const GUEST_KEY = "tapalog.display";
const GUEST_MAX = 50;
const LOOK_UP_LIMIT = 3000; // a slow server must not keep a book from opening

interface GuestEntry {
  bookId: string;
  display: Display;
  updatedAt: number;
}

function guestEntries(): GuestEntry[] {
  try {
    const list: unknown = JSON.parse(store.get(GUEST_KEY) ?? "[]");
    return Array.isArray(list) ? (list as GuestEntry[]).filter((e) => e && typeof e.bookId === "string" && typeof e.display === "object" && e.display !== null) : [];
  } catch {
    return [];
  }
}

/** The settings for this book; none (the file's own look) when there are none or the server did not answer in time. */
export async function loadDisplay(signedIn: boolean, bookId: string): Promise<Display> {
  if (!signedIn) return guestEntries().find((e) => e.bookId === bookId)?.display ?? {};
  try {
    const res = await fetch(`/api/display/${encodeURIComponent(bookId)}`, { credentials: "same-origin", signal: AbortSignal.timeout(LOOK_UP_LIMIT) });
    return res.ok ? (((await res.json()) as { display: Display | null }).display ?? {}) : {};
  } catch {
    return {};
  }
}

/** Remembers the settings at once (they change rarely, and by a deliberate click). Settings that say nothing are forgotten. */
export function saveDisplay(signedIn: boolean, bookId: string, display: Display): void {
  if (!signedIn) {
    const others = guestEntries().filter((e) => e.bookId !== bookId);
    const mine: GuestEntry[] = Object.keys(display).length ? [{ bookId, display, updatedAt: Date.now() }] : [];
    store.set(GUEST_KEY, JSON.stringify([...mine, ...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, GUEST_MAX)));
    return;
  }
  void fetch(`/api/display/${encodeURIComponent(bookId)}`, {
    method: "PUT",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display }),
  }).catch(() => {});
}
