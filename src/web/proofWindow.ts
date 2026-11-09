import type * as Pdfjs from "pdfjs-dist/build/pdf.min.mjs";
import { lang, t } from "./i18n";
import { pdfDocumentOptions } from "./readers/pdfAssets";
import { api, ApiError, el, openModal, store } from "./ui";

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
/** A figure is cut from the PDF at up to this many pixels per point and no more than this many pixels on its longer side. */
const FIGURE_MAX_SCALE = 4;
const FIGURE_MAX_SIDE = 3200;
/** A frame smaller than this (in screen pixels) is a click. */
const MIN_FRAME = 16;

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
  /** Esc leaves the figure mode (set once the window is built) before it closes the window. */
  let leaveFigureMode: (() => boolean) | null = null;
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && leaveFigureMode?.()) e.stopImmediatePropagation();
  };
  addEventListener("keydown", onEscape, true);
  const finish = () => {
    closed = true;
    removeEventListener("beforeunload", warn);
    removeEventListener("keydown", onEscape, true);
    observer?.disconnect();
    void task?.destroy();
    for (const slot of slots.values()) if (slot.text.value !== slot.sent) void save(slot); // what was typed last is not lost with the window
    if (touched) opts.changed?.();
  };
  const modal = openModal(t("proof.title", { title: book.title }), finish);
  modal.body.closest(".modal")?.classList.add("proof");
  const say = (text: string) => modal.body.replaceChildren(el("p", { class: "muted", textContent: text }));
  say(t("card.loading"));

  const base = `/api/admin/ocr/${encodeURIComponent(book.id)}`;
  let held: Listing | null = null;
  try {
    held = await api<Listing>(`${base}/pages`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) {
      say(t("card.failed"));
      return;
    }
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
  // a book never recognized has nothing on the server: its pages are empty and it is started when the first page is saved
  const list: Listing = held ?? { pages: pdf.numPages, done: 0, edited: 0, lang: "", items: [] };
  let started = held !== null;
  let starting: Promise<unknown> | null = null;
  const url = (n: number) => `${base}/edit/${n}`;
  const preferredLang = () => (store.get("tapalog.ocrLang") === "rus+eng" ? "rus+eng" : "rus");
  async function ensureStarted(): Promise<void> {
    if (started) return;
    starting ??= api(`${base}/start`, { pages: list.pages, lang: preferredLang() }).finally(() => (starting = null));
    await starting;
    started = true;
    for (const button of downloads) button.hidden = false;
  }

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
      await ensureStarted();
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

  /** Waits until every page typed has reached the server (a page that keeps failing is given up after a few seconds). */
  async function flush(): Promise<void> {
    for (let i = 0; i < 40 && unsaved(); i++) {
      await Promise.all([...slots.values()].filter((slot) => !slot.inflight && slot.text.value !== slot.sent).map((slot) => save(slot)));
      if (unsaved()) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async function download(format: "md" | "txt"): Promise<void> {
    await flush();
    const link = el("a", { href: `${base}/text?format=${format}&lang=${lang()}` });
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
  }
  const downloads = (["md", "txt"] as const).map((format) => {
    const button = el("button", { type: "button", class: `btn small proof-download proof-download-${format}`, textContent: t(`proof.download.${format}`), hidden: !started });
    button.addEventListener("click", () => void download(format));
    return button;
  });

  const scroller = el("div", { class: "proof-pages" });
  const figureButton = el("button", { type: "button", class: "btn small proof-figure", textContent: t("proof.figure.mode"), title: t("proof.figure.hint") });
  figureButton.setAttribute("aria-pressed", "false");
  const hint = el("p", { class: "muted small proof-hint", textContent: t("proof.figure.hint"), hidden: true });
  let selecting = false;
  const selectMode = (on: boolean) => {
    selecting = on;
    scroller.classList.toggle("selecting", on);
    figureButton.classList.toggle("active", on);
    figureButton.setAttribute("aria-pressed", String(on));
    hint.hidden = !on;
  };
  figureButton.addEventListener("click", () => selectMode(!selecting));
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
  modal.body.replaceChildren(el("div", { class: "proof-bar" }, stats, el("label", { class: "proof-jump small muted" }, t("proof.goto"), goto), el("span", { class: "proof-actions" }, figureButton, ...downloads)), hint, scroller);

  /** Cuts the framed part of a page out of the PDF (drawn again for it, sharper than the page on the screen), keeps it on the server and writes its reference into the text. */
  async function cutFigure(slot: Slot, frame: { x: number; y: number; w: number; h: number }): Promise<void> {
    const say = (text: string) => (slot.state.textContent = text);
    say(t("proof.figure.cutting"));
    try {
      const page = await doc.getPage(slot.n);
      const size = page.getViewport({ scale: 1 });
      const scale = Math.min(FIGURE_MAX_SCALE, FIGURE_MAX_SIDE / Math.max(frame.w * size.width, frame.h * size.height));
      const viewport = page.getViewport({ scale });
      const canvas = el("canvas");
      canvas.width = Math.max(1, Math.round(frame.w * viewport.width));
      canvas.height = Math.max(1, Math.round(frame.h * viewport.height));
      await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -frame.x * viewport.width, -frame.y * viewport.height] }).promise;
      page.cleanup();
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = canvas.height = 0;
      if (!png) throw new Error("no picture");
      await ensureStarted();
      const res = await fetch(`${base}/images?page=${slot.n}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/png" }, body: png });
      if (!res.ok) throw new ApiError(res.status, res.statusText);
      const image = (await res.json()) as { name: string };
      insertFigure(slot, image.name);
      say(t("proof.figure.added"));
    } catch {
      say(t("proof.figure.failed"));
    }
  }

  /** Puts `![Fig. 8.1](images/p008-1.png)` at the cursor of the page's text, as a paragraph of its own. */
  function insertFigure(slot: Slot, name: string): void {
    const field = slot.text;
    const [, page, number] = /^p0*(\d+)-(\d+)\.png$/.exec(name) ?? [];
    const ref = `![${t("proof.figure.alt", { n: `${page}.${number}` })}](images/${name})`;
    const at = Math.min(field.selectionStart, field.value.length);
    const end = Math.min(field.selectionEnd, field.value.length);
    const before = field.value.slice(0, at);
    const after = field.value.slice(end);
    const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const tail = after === "" || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    field.value = before + lead + ref + tail + after;
    const caret = (before + lead + ref).length;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event("input")); // saved like anything typed
  }

  let drag: { slot: Slot; scan: HTMLElement; canvas: HTMLCanvasElement; pointer: number; x0: number; y0: number; box: HTMLElement } | null = null;
  const stopDrag = () => {
    drag?.box.remove();
    drag = null;
  };
  scroller.addEventListener("pointerdown", (e) => {
    if (!selecting || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    const scan = (e.target as HTMLElement).closest<HTMLElement>(".proof-scan");
    const canvas = scan?.querySelector("canvas");
    const slot = scan?.parentElement ? slots.get(Number((scan.parentElement as HTMLElement).dataset.page)) : undefined;
    if (!scan || !canvas || !slot) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const box = el("div", { class: "proof-rect" });
    scan.append(box);
    scan.setPointerCapture(e.pointerId);
    drag = { slot, scan, canvas, pointer: e.pointerId, x0: Math.min(Math.max(e.clientX, rect.left), rect.right), y0: Math.min(Math.max(e.clientY, rect.top), rect.bottom), box };
  });
  /** The frame in pixels of the picture on the screen, kept inside the page. */
  const frameOf = (e: PointerEvent) => {
    const d = drag!;
    const rect = d.canvas.getBoundingClientRect();
    const x1 = Math.min(Math.max(e.clientX, rect.left), rect.right);
    const y1 = Math.min(Math.max(e.clientY, rect.top), rect.bottom);
    return { left: Math.min(d.x0, x1) - rect.left, top: Math.min(d.y0, y1) - rect.top, width: Math.abs(x1 - d.x0), height: Math.abs(y1 - d.y0), page: rect };
  };
  scroller.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const f = frameOf(e);
    const offset = drag.canvas.getBoundingClientRect();
    const scan = drag.scan.getBoundingClientRect();
    Object.assign(drag.box.style, { left: `${f.left + offset.left - scan.left}px`, top: `${f.top + offset.top - scan.top}px`, width: `${f.width}px`, height: `${f.height}px` });
  });
  scroller.addEventListener("pointerup", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const f = frameOf(e);
    const { slot } = drag;
    stopDrag();
    if (f.width < MIN_FRAME || f.height < MIN_FRAME) return; // a click, not a frame
    void cutFigure(slot, { x: f.left / f.page.width, y: f.top / f.page.height, w: f.width / f.page.width, h: f.height / f.page.height });
  });
  scroller.addEventListener("pointercancel", stopDrag);
  leaveFigureMode = () => {
    if (!selecting) return false;
    if (drag) stopDrag();
    else selectMode(false);
    return true; // the next Esc closes the window
  };

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
