import { api, store } from "./ui";

/** Where a reader left a book: the view the reader reported, and a short name of that place ("Page 12"). */
export interface Place {
  bookId: string;
  view: unknown;
  label: string;
  updatedAt: number;
}

/** A signed-in reader's places live on the server (they follow the account to other devices); a guest's live in this browser only and never move to an account. */
const GUEST_KEY = "tapalog.places";
const GUEST_MAX = 50;
const SAVE_DELAY = 1500; // a place is sent when the reader has been still this long, not at every scroll step
const LOOK_UP_LIMIT = 3000; // a slow server must not keep a book from opening

function guestPlaces(): Place[] {
  try {
    const list: unknown = JSON.parse(store.get(GUEST_KEY) ?? "[]");
    return Array.isArray(list) ? (list as Place[]).filter((p) => p && typeof p.bookId === "string" && typeof p.updatedAt === "number") : [];
  } catch {
    return [];
  }
}

/** The books the reader has been reading, most recent first. */
export async function recentPlaces(signedIn: boolean): Promise<Place[]> {
  if (!signedIn) return guestPlaces().sort((a, b) => b.updatedAt - a.updatedAt);
  try {
    return (await api<{ progress: Place[] }>("/api/progress")).progress;
  } catch {
    return [];
  }
}

/** Where the reader was in this book, or null (never opened, or the server did not answer in time: the book then opens at its start). */
export async function savedPlace(signedIn: boolean, bookId: string): Promise<Place | null> {
  if (!signedIn) return guestPlaces().find((p) => p.bookId === bookId) ?? null;
  try {
    const res = await fetch(`/api/progress/${encodeURIComponent(bookId)}`, { credentials: "same-origin", signal: AbortSignal.timeout(LOOK_UP_LIMIT) });
    return res.ok ? ((await res.json()) as { progress: Place | null }).progress : null;
  } catch {
    return null;
  }
}

export interface Tracker {
  /** The reader reported a new place. */
  view(view: unknown): void;
  /** Sends what is waiting now and stops tracking. */
  stop(): void;
}

/**
 * Keeps one open book's place. The book counts as read from the moment it is opened, so it shows in
 * "continue reading" even when its reader reports no place. A page that is closed or hidden sends at once.
 */
export function trackPlace(signedIn: boolean, bookId: string, label: () => string | undefined): Tracker {
  let latest: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const send = () => {
    clearTimeout(timer);
    timer = undefined;
    const view = latest;
    const text = label()?.trim() ?? "";
    latest = undefined;
    if (!signedIn) {
      const now = Date.now();
      const others = guestPlaces().filter((p) => p.bookId !== bookId);
      const mine = guestPlaces().find((p) => p.bookId === bookId);
      const place: Place = { bookId, view: view ?? mine?.view ?? null, label: view === undefined ? (mine?.label ?? "") : text, updatedAt: now };
      store.set(GUEST_KEY, JSON.stringify([place, ...others].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, GUEST_MAX)));
      return;
    }
    // keepalive lets the request finish while the page is closing
    void fetch(`/api/progress/${encodeURIComponent(bookId)}`, {
      method: "PUT",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(view === undefined ? {} : { view, label: text }),
    }).catch(() => {});
  };
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(send, SAVE_DELAY);
  };
  const onHide = () => {
    if (document.visibilityState === "hidden" && timer !== undefined) send();
  };
  const onPageHide = () => timer !== undefined && send();
  document.addEventListener("visibilitychange", onHide);
  addEventListener("pagehide", onPageHide);
  schedule(); // opened

  return {
    view(view) {
      if (stopped) return;
      latest = view;
      schedule();
    },
    stop() {
      if (stopped) return;
      if (timer !== undefined) send();
      stopped = true;
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("pagehide", onPageHide);
    },
  };
}
