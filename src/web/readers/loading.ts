import { t } from "../i18n";
import { el, formatBytes } from "../ui";
import type { Progress } from "./download";

/** The bar a reader shows in its own area while the book is on its way, until something can be read. */
export interface Loading {
  /** Bytes that have arrived so far. */
  update(progress: Progress): void;
  /** The file is here and is being opened: no more bytes to count. */
  opening(): void;
  /** Something is on screen: the bar goes away (for good). */
  done(): void;
}

export type { Progress } from "./download";

/** What the page says for a download: "Loading: 12.3 MB of 87.0 MB (14%)", or only what has arrived when the size is unknown. */
export function progressText(p: Progress): string {
  if (p.total && p.total > 0) {
    const percent = Math.min(100, Math.floor((p.loaded / p.total) * 100));
    return t("loading.progress", { done: formatBytes(p.loaded), total: formatBytes(p.total), percent });
  }
  return t("loading.bytes", { done: formatBytes(p.loaded) });
}

/**
 * Shows the bar over `host` (a reader's area) after a short wait, so a book that opens at once is never covered by a flash of it.
 * Whatever the reader puts into `host` meanwhile stays under it.
 */
export function showLoading(host: HTMLElement, delay = 300): Loading {
  const text = el("div", { class: "loading-text", textContent: t("loading.start") });
  const fill = el("div", { class: "loading-fill" });
  const track = el("div", { class: "loading-track" }, fill);
  const root = el("div", { class: "reader-loading", hidden: true }, el("div", { class: "loading-box" }, text, track));
  root.setAttribute("role", "status");
  track.classList.add("indeterminate");
  host.append(root);
  let gone = false;
  const timer = setTimeout(() => {
    if (!gone) root.hidden = false;
  }, delay);
  return {
    update(p) {
      if (gone) return;
      text.textContent = progressText(p);
      if (p.total && p.total > 0) {
        track.classList.remove("indeterminate");
        fill.style.width = `${Math.min(100, (p.loaded / p.total) * 100)}%`;
      } else {
        track.classList.add("indeterminate");
        fill.style.width = "";
      }
    },
    opening() {
      if (gone) return;
      text.textContent = t("loading.opening");
      track.classList.add("indeterminate");
      fill.style.width = "";
    },
    done() {
      gone = true;
      clearTimeout(timer);
      root.remove();
    },
  };
}

/**
 * A small note at the foot of a reader's area that tells a page of a book is still coming (a comic is read in pieces, so
 * the next page can take a while on a slow line); it appears only if the wait lasts, and shows what has arrived since it began.
 */
export interface Busy {
  /** Called as pieces are asked for and arrive: how many requests are in flight and how many bytes came since the wait began. */
  report(pending: number, bytes: number): void;
  destroy(): void;
}

export function showBusy(host: HTMLElement, delay = 400): Busy {
  const note = el("div", { class: "reader-busy", hidden: true });
  note.setAttribute("role", "status");
  host.append(note);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest = 0;
  const draw = () => {
    note.textContent = t("loading.page", { done: formatBytes(latest) });
  };
  return {
    report(pending, bytes) {
      latest = bytes;
      if (pending > 0) {
        draw();
        if (!timer && note.hidden) {
          timer = setTimeout(() => {
            timer = null;
            note.hidden = false;
            draw();
          }, delay);
        }
      } else {
        if (timer) clearTimeout(timer);
        timer = null;
        note.hidden = true;
      }
    },
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
      note.remove();
    },
  };
}
