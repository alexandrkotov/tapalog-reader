import type * as Pdfjs from "pdfjs-dist/build/pdf.min.mjs";
import { t } from "./i18n";
import { pdfDocumentOptions } from "./readers/pdfAssets";
import { api, el, openModal } from "./ui";

interface PageItem {
  page: number;
  text: string;
  edited: boolean;
}

interface Listing {
  pages: number;
  done: number;
  edited: number;
  lang: string;
  items: PageItem[];
}

/** A page is drawn no wider than this, whatever the screen: the memory of a thousand-page book is the limit, not the sharpness. */
const MAX_CANVAS_WIDTH = 1800;
/** Pages this far (in pixels) beyond the edge of the window are drawn ahead; pages farther away are let go. */
const AHEAD = "1500px 0px";
/** A page is saved this long after the last key, or at once when the cursor leaves it. */
const SAVE_AFTER = 1000;
/** After a failure (the server or the network) the page is tried again after this. */
const RETRY_AFTER = 3000;

/** One page of the list: its parts, and what the server holds of it. */
interface Slot {
  n: number;
  scan: HTMLElement;
  text: HTMLTextAreaElement;
  state: HTMLElement;
  badge: HTMLElement;
  restore: HTMLButtonElement;
  /** The text the server holds (as it was typed or read), to tell what is still unsaved. */
  sent: string;
  edited: boolean;
  inflight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The window for checking the text of a recognized book: every page is one row, the picture of the scan on the left and
 * the text read from it on the right, and the whole list scrolls as one, so the two never part. Pictures are drawn when a
 * row comes near the window and let go when it is far, so a book of a thousand pages costs no more than a screenful.
 * The text can be corrected on the spot: a page is saved by itself a moment after the last key (or when the cursor
 * leaves it, or the window is closed), the recognizer never replaces it, and a button takes it back to what was read.
 */
export async function openProof(book: { id: string; title: string }, opts: { changed?: () => void } = {}): Promise<void> {
  let closed = false;
  let touched = false;
  let observer: IntersectionObserver | null = null;
  let task: Pdfjs.PDFDocumentLoadingTask | null = null;
  const slots = new Map<number, Slot>();
  const unsaved = () => [...slots.values()].some((s) => s.inflight || s.text.value !== s.sent);
  const warn = (e: BeforeUnloadEvent) => {
    if (unsaved()) e.preventDefault(); // a page is still on its way to the server
  };
  addEventListener("beforeunload", warn);
  const finish = () => {
    closed = true;
    removeEventListener("beforeunload", warn);
    observer?.disconnect();
    void task?.destroy();
    for (const slot of slots.values()) if (slot.text.value !== slot.sent) void save(slot); // what was typed last is not lost with the window
    if (touched) opts.changed?.();
  };
  const modal = openModal(t("proof.title", { title: book.title }), finish);
  modal.body.closest(".modal")?.classList.add("proof");
  const say = (text: string) => modal.body.replaceChildren(el("p", { class: "muted", textContent: text }));
  say(t("card.loading"));

  let list: Listing;
  try {
    list = await api<Listing>(`/api/admin/ocr/${encodeURIComponent(book.id)}/pages`);
  } catch {
    say(t("proof.none"));
    return;
  }
  if (closed) return;

  let pdfjs: typeof Pdfjs;
  let pdf: Pdfjs.PDFDocumentProxy;
  let aspect: number;
  try {
    pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    const loading = pdfjs.getDocument(pdfDocumentOptions(`/api/file/${encodeURIComponent(book.id)}`));
    task = loading;
    loading.onPassword = () => void loading.destroy();
    pdf = await loading.promise;
    const first = await pdf.getPage(1);
    const view = first.getViewport({ scale: 1 });
    aspect = view.width / view.height; // until a page is drawn, every row is as tall as the first page
    first.cleanup();
  } catch {
    if (!closed) say(t("proof.cantOpen"));
    return;
  }
  if (closed) return;
  const doc = pdf;
  const url = (n: number) => `/api/admin/ocr/${encodeURIComponent(book.id)}/edit/${n}`;

  const counts = { done: list.done, edited: list.edited };
  const stats = el("p", { class: "muted small proof-stats" });
  const showStats = () => {
    stats.textContent = t("proof.stats", { done: counts.done, pages: list.pages }) + (counts.edited ? ` · ${t("proof.editedCount", { n: counts.edited })}` : "");
  };
  showStats();

  const mark = (slot: Slot, edited: boolean) => {
    slot.edited = edited;
    slot.badge.hidden = slot.restore.hidden = !edited;
  };

  /** Sends what is typed on the page; if more was typed meanwhile, goes on until the server holds the last of it. */
  async function save(slot: Slot): Promise<void> {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    if (slot.inflight || slot.text.value === slot.sent) return;
    const value = slot.text.value;
    slot.inflight = true;
    slot.state.textContent = t("proof.state.saving");
    try {
      const result = await api<{ done: number; edited: number }>(url(slot.n), { text: value }, "PUT");
      slot.sent = value;
      touched = true;
      counts.done = result.done;
      counts.edited = result.edited;
      mark(slot, true);
      showStats();
      slot.state.textContent = slot.text.value === value ? t("proof.state.saved") : t("proof.state.unsaved");
    } catch {
      slot.state.textContent = t("proof.state.retry");
      slot.inflight = false;
      if (!closed) slot.timer = setTimeout(() => void save(slot), RETRY_AFTER);
      return;
    }
    slot.inflight = false;
    if (slot.text.value !== slot.sent) void save(slot);
  }

  async function restore(slot: Slot): Promise<void> {
    if (!confirm(t("proof.restoreAsk", { n: slot.n }))) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    while (slot.inflight) await new Promise((resolve) => setTimeout(resolve, 50)); // leaving the page may have started a save: let it land first
    slot.inflight = true;
    try {
      const result = await api<{ page: PageItem | null }>(url(slot.n), undefined, "DELETE");
      slot.text.value = slot.sent = result.page?.text ?? "";
      slot.text.placeholder = result.page ? "" : t("proof.unread");
      touched = true;
      counts.edited = Math.max(0, counts.edited - 1);
      if (!result.page) counts.done = Math.max(0, counts.done - 1);
      mark(slot, false);
      showStats();
      slot.state.textContent = "";
    } catch {
      slot.state.textContent = t("proof.state.restoreFailed");
    } finally {
      slot.inflight = false;
    }
  }

  const scroller = el("div", { class: "proof-pages" });
  const byPage = new Map(list.items.map((item) => [item.page, item]));
  for (let n = 1; n <= list.pages; n++) {
    const item = byPage.get(n);
    const scan = el("div", { class: "proof-scan" });
    scan.style.aspectRatio = String(aspect);
    const text = el("textarea", { class: "proof-text", value: item?.text ?? "", spellcheck: false, placeholder: item ? "" : t("proof.unread") });
    const badge = el("span", { class: "proof-badge", textContent: t("proof.edited"), hidden: !item?.edited });
    const state = el("span", { class: "muted small proof-state" });
    const restoreButton = el("button", { type: "button", class: "btn small proof-restore", textContent: t("proof.restore"), hidden: !item?.edited });
    const head = el("div", { class: "proof-head" }, el("span", { class: "proof-label", textContent: t("proof.page", { n }) }), badge, el("span", { class: "proof-gap" }), state, restoreButton);
    const row = el("section", { class: "proof-row" }, scan, el("div", { class: "proof-side" }, head, text));
    row.dataset.page = String(n);
    const slot: Slot = { n, scan, text, state, badge, restore: restoreButton, sent: item?.text ?? "", edited: !!item?.edited, inflight: false, timer: null };
    slots.set(n, slot);
    text.addEventListener("input", () => {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      if (slot.text.value === slot.sent && !slot.inflight) {
        slot.state.textContent = slot.edited ? t("proof.state.saved") : ""; // typed back to what the server holds: nothing to send
        return;
      }
      slot.state.textContent = t("proof.state.unsaved");
      slot.timer = setTimeout(() => void save(slot), SAVE_AFTER);
    });
    text.addEventListener("blur", () => void save(slot));
    restoreButton.addEventListener("click", () => void restore(slot));
    scroller.append(row);
  }

  const goto = el("input", { type: "number", class: "proof-goto", min: "1", max: String(list.pages), placeholder: "№", title: t("proof.goto") });
  goto.addEventListener("change", () => {
    const n = Math.round(Number(goto.value));
    const row = scroller.children[Math.min(Math.max(n, 1), list.pages) - 1] as HTMLElement | undefined;
    if (row) scroller.scrollTo({ top: row.offsetTop });
  });
  modal.body.replaceChildren(el("div", { class: "proof-bar" }, stats, el("label", { class: "proof-jump small muted" }, t("proof.goto"), goto)), scroller);

  const canvases = new Map<number, HTMLCanvasElement>();
  const drawing = new Set<number>();
  const wanted = new Set<number>();

  async function draw(n: number): Promise<void> {
    if (canvases.has(n) || drawing.has(n)) return;
    const scan = slots.get(n)!.scan;
    drawing.add(n);
    try {
      const page = await doc.getPage(n);
      if (closed || !wanted.has(n)) {
        page.cleanup(); // scrolled past while the page was being fetched
        return;
      }
      const base = page.getViewport({ scale: 1 });
      const width = Math.min((scan.clientWidth || 600) * (devicePixelRatio || 1), MAX_CANVAS_WIDTH);
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = el("canvas", { class: "proof-canvas" });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
      if (closed || !wanted.has(n)) {
        canvas.width = canvas.height = 0;
        return;
      }
      scan.replaceChildren(canvas);
      scan.style.aspectRatio = String(canvas.width / canvas.height);
      canvases.set(n, canvas);
    } catch {
      if (!closed) {
        scan.className = "proof-scan proof-failed";
        scan.textContent = t("proof.pageFailed");
      }
    } finally {
      drawing.delete(n);
    }
  }

  function release(n: number): void {
    const canvas = canvases.get(n);
    if (!canvas) return;
    canvas.width = canvas.height = 0; // the memory goes back at once
    slots.get(n)?.scan.replaceChildren();
    canvases.delete(n);
  }

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const n = Number((entry.target as HTMLElement).dataset.page);
        if (entry.isIntersecting) {
          wanted.add(n);
          void draw(n);
        } else {
          wanted.delete(n);
          release(n);
        }
      }
    },
    { root: scroller, rootMargin: AHEAD },
  );
  for (const row of scroller.children) observer.observe(row);
}
