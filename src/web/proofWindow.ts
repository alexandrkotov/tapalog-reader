import type * as Pdfjs from "pdfjs-dist/build/pdf.min.mjs";
import { lang, t } from "./i18n";
import { makeResizable, type Resizable } from "./modalResize";
import { figureScale, MAX_ATTEMPTS, MAX_PNG_BYTES, scrollStep } from "./proofFigure";
import { askFormula } from "./formulaDialog";
import { createPageEditor, type Format, type PageEditor } from "./pageEditor";
import { pdfDocumentOptions } from "./readers/pdfAssets";
import { api, ApiError, el, formatBytes, openModal, store } from "./ui";

interface PageItem {
  page: number;
  text: string;
  edited: boolean;
}

/** A picture cut from a page of the scan, kept on the server. */
interface ImageItem {
  name: string;
  page: number;
  size: number;
}

interface Listing {
  pages: number;
  done: number;
  edited: number;
  lang: string;
  items: PageItem[];
  images: ImageItem[];
}

/** The text without the references to one picture, tidied as the server tidies it. */
function withoutReference(text: string, name: string): string {
  const ref = new RegExp(`!\\[[^\\]\\n]*\\]\\(images/${name.replace(/\./g, "\\.")}\\)`, "g");
  return text.replace(ref, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A page is drawn no wider than this, whatever the screen: the memory of a thousand-page book is the limit, not the sharpness. */
const MAX_CANVAS_WIDTH = 1800;
/** Pages this far (in pixels) beyond the edge of the window are drawn ahead; pages farther away are let go. */
const AHEAD = "1500px 0px";
/** A page is saved this long after the last key, or at once when the cursor leaves it. */
const SAVE_AFTER = 1000;
/** After a failure (the server or the network) the page is tried again after this. */
const RETRY_AFTER = 3000;
/** Gives a scan the proportions of its page; --aspect lets the style sheet size it to the room it has. */
function setAspect(scan: HTMLElement, ratio: number): void {
  scan.style.aspectRatio = String(ratio);
  scan.style.setProperty("--aspect", String(ratio));
}
/** A frame smaller than this (in screen pixels) is a click. */
const MIN_FRAME = 16;

/** One page of the list: its parts, and what the server holds of it. */
interface Slot {
  n: number;
  scan: HTMLElement;
  text: HTMLTextAreaElement;
  /** Where the visual editor of the text stands while the page is near the window; the textarea always holds the text, whichever of the two is shown. */
  host: HTMLElement;
  editor: PageEditor | null;
  /** Counts the starts of the editor, so that one that is late (the page has been left, or the mode changed) is dropped. */
  mounts: number;
  state: HTMLElement;
  /** The pictures cut from this page, as small pictures under its heading, to put into the text again or to delete. */
  figs: HTMLElement;
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
  /** The window's size (it can be stretched), the watch on the list's width and the wait before the scans are drawn again for it. */
  let sizing: Resizable | null = null;
  let sizeWatch: ResizeObserver | null = null;
  let sharpenTimer: ReturnType<typeof setTimeout> | undefined;
  const slots = new Map<number, Slot>();
  const unsaved = () => [...slots.values()].some((s) => s.inflight || s.text.value !== s.sent);
  const warn = (e: BeforeUnloadEvent) => {
    if (unsaved()) e.preventDefault(); // a page is still on its way to the server
  };
  addEventListener("beforeunload", warn);
  /** Esc leaves the figure mode (set once the window is built) before it closes the window. */
  let leaveFigureMode: (() => boolean) | null = null;
  /** Stops the PDF being made when the window is closed. */
  let pdfAbort: AbortController | null = null;
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && leaveFigureMode?.()) e.stopImmediatePropagation();
  };
  addEventListener("keydown", onEscape, true);
  const finish = () => {
    closed = true;
    removeEventListener("beforeunload", warn);
    removeEventListener("keydown", onEscape, true);
    pdfAbort?.abort();
    observer?.disconnect();
    sizeWatch?.disconnect();
    clearTimeout(sharpenTimer);
    sizing?.dispose();
    void task?.destroy();
    for (const slot of slots.values()) {
      if (slot.text.value !== slot.sent) void save(slot); // what was typed last is not lost with the window
      void slot.editor?.destroy();
      slot.editor = null;
    }
    if (touched) opts.changed?.();
  };
  const modal = openModal(t("proof.title", { title: book.title }), finish);
  const box = modal.body.closest<HTMLElement>(".modal");
  box?.classList.add("proof");
  if (box) sizing = makeResizable(box, { key: "tapalog.proofSize", expandLabel: t("proof.expand"), restoreLabel: t("proof.restoreSize"), scroller: () => modal.body.querySelector<HTMLElement>(".proof-pages") });
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
  const list: Listing = held ?? { pages: pdf.numPages, done: 0, edited: 0, lang: "", items: [], images: [] };
  list.images ??= [];
  let imageCount = list.images.length;
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
    showZip();
    pdfButton.hidden = false;
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
      slot.sent = result.page?.text ?? "";
      setText(slot, slot.sent);
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
  async function download(format: "md" | "txt" | "zip"): Promise<void> {
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

  const zipButton = el("button", { type: "button", class: "btn small proof-download proof-download-zip", textContent: t("proof.download.zip"), hidden: !started || imageCount === 0 });
  zipButton.addEventListener("click", () => void download("zip"));
  const showZip = () => (zipButton.hidden = !started || imageCount === 0);

  // a new PDF made of the text and the figures: set by the browser and only downloaded, never put into the library
  const pdfButton = el("button", { type: "button", class: "btn small proof-pdf-open", textContent: t("proof.pdf.button"), hidden: !started });
  pdfButton.setAttribute("aria-expanded", "false");
  const formatSelect = el("select", { class: "proof-pdf-format" }, el("option", { value: "a4", textContent: "A4" }), el("option", { value: "a5", textContent: "A5" }));
  formatSelect.value = store.get("tapalog.pdfFormat") === "a5" ? "a5" : "a4";
  const headingsBox = el("input", { type: "checkbox", class: "proof-pdf-headings", checked: store.get("tapalog.pdfHeadings") !== "0" });
  const runButton = el("button", { type: "button", class: "btn small primary proof-pdf-run", textContent: t("proof.pdf.run") });
  const pdfState = el("span", { class: "muted small proof-pdf-state" });
  pdfState.setAttribute("role", "status");
  const pdfPanel = el("div", { class: "proof-pdf", hidden: true }, el("label", {}, t("proof.pdf.format"), formatSelect), el("label", {}, headingsBox, t("proof.pdf.headings")), runButton, pdfState);
  pdfButton.addEventListener("click", () => {
    pdfPanel.hidden = !pdfPanel.hidden;
    pdfButton.setAttribute("aria-expanded", String(!pdfPanel.hidden));
  });
  async function exportPdf(): Promise<void> {
    const format = formatSelect.value === "a5" ? "a5" : "a4";
    store.set("tapalog.pdfFormat", format);
    store.set("tapalog.pdfHeadings", headingsBox.checked ? "1" : "0");
    runButton.disabled = true;
    const abort = (pdfAbort = new AbortController());
    pdfState.textContent = t("proof.pdf.preparing");
    try {
      await flush(); // what was typed is on the server before the book is read from it
      const data = await api<Listing>(`${base}/pages`);
      const pages = data.items.filter((item) => item.text.trim()).map((item) => ({ page: item.page, text: item.text }));
      if (!pages.length) {
        pdfState.textContent = t("proof.pdf.empty");
        return;
      }
      const { buildBookPdf } = await import("./proofPdfFile"); // the PDF library comes only now
      const bytes = await buildBookPdf(
        {
          title: book.title,
          note: data.done < data.pages ? `${t("proof.stats", { done: data.done, pages: data.pages })}.` : undefined,
          pages,
          pageLabel: headingsBox.checked ? (n) => t("proof.page", { n }) : null,
          missing: (alt) => t("proof.pdf.missing", { alt }),
          figure: async (name) => {
            const res = await fetch(`${base}/images/${name}`, { credentials: "same-origin", signal: abort.signal });
            if (!res.ok) throw new ApiError(res.status, res.statusText);
            return res.blob();
          },
        },
        {
          format,
          signal: abort.signal,
          onProgress: (p) => (pdfState.textContent = t(p.stage === "figures" ? "proof.pdf.figures" : "proof.pdf.pages", { done: p.done, total: p.total })),
        },
      );
      const name = `${book.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120) || "book"}.pdf`;
      const link = el("a", { href: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" })), download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      pdfState.textContent = t("proof.pdf.done", { name, size: formatBytes(bytes.length) });
    } catch (err) {
      pdfState.textContent = abort.signal.aborted || (err instanceof DOMException && err.name === "AbortError") ? "" : t("proof.pdf.failed");
    } finally {
      runButton.disabled = false;
    }
  }
  runButton.addEventListener("click", () => void exportPdf());
  const scroller = el("div", { class: "proof-pages" });
  const figureButton = el("button", { type: "button", class: "btn small proof-figure", textContent: t("proof.figure.mode"), title: t("proof.figure.hint") });
  figureButton.setAttribute("aria-pressed", "false");
  const hint = el("p", { class: "muted small proof-hint", textContent: t("proof.figure.hint"), hidden: true });
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  /** What just happened, in the line of the mode: with a finger the text beside the scan may be out of sight. */
  const flashHint = (text: string) => {
    hint.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (hint.textContent = t("proof.figure.hint")), 3500);
  };
  // the text of a page is edited as it is shown (bold, headings, formulas, the figures in place) or as the plain text it is kept as; remembered like the size of the window
  const sourceButton = el("button", { type: "button", class: "btn small proof-source", textContent: t("proof.source"), title: t("proof.sourceHint") });
  let visual = store.get("tapalog.proofEditor") !== "source";
  // the tools act on the page whose editor the cursor was last in
  let active: Slot | null = null;
  const tools = el("div", { class: "proof-tools", role: "toolbar" });
  tools.setAttribute("aria-label", t("proof.tools"));
  tools.addEventListener("mousedown", (e) => e.preventDefault()); // the cursor stays in the text
  const toolButtons: HTMLButtonElement[] = [];
  const addTool = (label: string, tip: Parameters<typeof t>[0], className: string, run: (slot: Slot) => void) => {
    const button = el("button", { type: "button", class: `btn small proof-tool ${className}`, textContent: label, title: t(tip), disabled: true });
    button.setAttribute("aria-label", t(tip));
    button.addEventListener("click", () => active?.editor && run(active));
    toolButtons.push(button);
    tools.append(button);
  };
  const formats: [Format, string, Parameters<typeof t>[0]][] = [
    ["bold", "B", "proof.tool.bold"],
    ["italic", "I", "proof.tool.italic"],
    ["code", "‹›", "proof.tool.code"],
    ["heading", "H", "proof.tool.heading"],
    ["bullet", "•", "proof.tool.bullet"],
    ["ordered", "1.", "proof.tool.ordered"],
    ["quote", "❝", "proof.tool.quote"],
  ];
  for (const [format, label, tip] of formats) addTool(label, tip, `proof-tool-${format}`, (slot) => slot.editor?.format(format));
  for (const block of [false, true]) {
    addTool(block ? "∑ ¶" : "∑", block ? "proof.tool.formulaBlock" : "proof.tool.formula", block ? "proof-tool-formula-block" : "proof-tool-formula", (slot) => {
      void askFormula({ latex: "", block }).then((formula) => {
        if (formula && formula !== "delete") slot.editor?.insertFormula(formula); // the page may have been left meanwhile
      });
    });
  }
  const showTools = () => {
    tools.hidden = !visual;
    for (const button of toolButtons) button.disabled = !(visual && active?.editor);
  };
  const showMode = () => {
    showTools();
    scroller.classList.toggle("visual", visual);
    sourceButton.classList.toggle("primary", !visual);
    sourceButton.setAttribute("aria-pressed", String(!visual));
  };
  sourceButton.addEventListener("click", () => {
    visual = !visual;
    store.set("tapalog.proofEditor", visual ? "visual" : "source");
    showMode();
    for (const slot of slots.values()) {
      if (visual && wanted.has(slot.n)) void mountEditor(slot);
      if (!visual) unmountEditor(slot);
    }
  });
  /** Sets the text of a page from outside the editor (a page taken back, a figure taken out), and the editor with it. */
  function setText(slot: Slot, value: string): void {
    slot.text.value = value;
    slot.editor?.set(value);
    slot.host.classList.toggle("empty", value === "");
  }
  /** Starts the editor on a page that is near the window; the text goes on being kept in the textarea, so nothing is lost when the editor goes. */
  async function mountEditor(slot: Slot): Promise<void> {
    if (!visual || slot.editor || closed) return;
    const mount = ++slot.mounts;
    const started = slot.text.value;
    try {
      const editor = await createPageEditor(slot.host, started, {
        askFormula: (current) => askFormula({ ...current, editing: true }),
        resolveImage: (src) => (/^images\/p\d+-\d+\.png$/.test(src) ? `${base}/${src}` : src),
        onChange: (text) => {
          slot.text.value = text;
          slot.host.classList.toggle("empty", text === "");
          slot.text.dispatchEvent(new Event("input")); // saved like anything typed
        },
      });
      if (closed || !visual || mount !== slot.mounts || !wanted.has(slot.n)) {
        void editor.destroy(); // the page was left, or the mode changed, while the editor was starting
        return;
      }
      slot.editor = editor;
      showTools();
      if (slot.text.value !== started) editor.set(slot.text.value); // changed meanwhile (a figure put in)
      slot.host.classList.toggle("empty", slot.text.value === "");
    } catch {
      if (closed) return;
      visual = false; // the editor could not be loaded: the plain text is there, as it was
      showMode();
      flashHint(t("proof.editorFailed"));
    }
  }
  function unmountEditor(slot: Slot): void {
    slot.mounts++;
    const editor = slot.editor;
    slot.editor = null;
    if (active === slot) active = null;
    showTools();
    if (!editor) return;
    void editor.destroy().then(() => slot.host.replaceChildren());
  }
  // "the page whole in the window": remembered like the size of the window
  const fitButton = el("button", { type: "button", class: "btn small proof-fit", textContent: t("proof.fit"), title: t("proof.fitHint") });
  let fit = false;
  /** The list's height is what a page may be as tall as when it is shown whole. */
  function setFitHeight(): void {
    scroller.style.setProperty("--fit-h", `${scroller.clientHeight}px`);
  }
  function setFit(on: boolean): void {
    const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0; // the rows take a new height: stay at the same place of the book
    fit = on;
    scroller.classList.toggle("fit", on);
    fitButton.classList.toggle("primary", on);
    fitButton.setAttribute("aria-pressed", String(on));
    setFitHeight();
    if (ratio > 0) scroller.scrollTop = ratio * scroller.scrollHeight;
    sharpen(); // the scans now have another size
  }
  fitButton.setAttribute("aria-pressed", "false");
  fitButton.addEventListener("click", () => {
    setFit(!fit);
    store.set("tapalog.proofFit", fit ? "1" : "0");
  });
  let selecting = false;
  const selectMode = (on: boolean) => {
    selecting = on;
    scroller.classList.toggle("selecting", on);
    figureButton.classList.toggle("primary", on);
    figureButton.setAttribute("aria-pressed", String(on));
    hint.hidden = !on;
  };
  figureButton.addEventListener("click", () => selectMode(!selecting));
  showMode();
  const byPage = new Map(list.items.map((item) => [item.page, item]));
  for (let n = 1; n <= list.pages; n++) {
    const item = byPage.get(n);
    const scan = el("div", { class: "proof-scan" });
    setAspect(scan, aspect);
    const text = el("textarea", { class: "proof-text", value: item?.text ?? "", spellcheck: false, placeholder: item ? "" : t("proof.unread") });
    const badge = el("span", { class: "proof-badge", textContent: t("proof.edited"), hidden: !item?.edited });
    const state = el("span", { class: "muted small proof-state" });
    const restoreButton = el("button", { type: "button", class: "btn small proof-restore", textContent: t("proof.restore"), hidden: !item?.edited });
    const wholeButton = el("button", { type: "button", class: "btn small proof-whole", textContent: t("proof.figure.whole"), title: t("proof.figure.wholeHint") });
    const head = el("div", { class: "proof-head" }, el("span", { class: "proof-label", textContent: t("proof.page", { n }) }), badge, el("span", { class: "proof-gap" }), state, restoreButton, wholeButton);
    const figs = el("div", { class: "proof-figs" });
    const host = el("div", { class: "proof-editor" });
    host.dataset.placeholder = item ? "" : t("proof.unread");
    host.classList.toggle("empty", !item?.text);
    const row = el("section", { class: "proof-row" }, scan, el("div", { class: "proof-side" }, head, figs, text, host));
    row.dataset.page = String(n);
    const slot: Slot = { n, scan, text, host, editor: null, mounts: 0, state, figs, badge, restore: restoreButton, sent: item?.text ?? "", edited: !!item?.edited, inflight: false, timer: null };
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
    host.addEventListener("focusout", () => void save(slot));
    host.addEventListener("focusin", () => {
      active = slot;
      showTools();
    });
    restoreButton.addEventListener("click", () => void restore(slot));
    wholeButton.addEventListener("click", () => void cutFigure(slot, { x: 0, y: 0, w: 1, h: 1 })); // the page as one figure: no frame to draw, however tall the window is
    scroller.append(row);
  }

  const goto = el("input", { type: "number", class: "proof-goto", min: "1", max: String(list.pages), placeholder: "№", title: t("proof.goto") });
  goto.addEventListener("change", () => {
    const n = Math.round(Number(goto.value));
    const row = scroller.children[Math.min(Math.max(n, 1), list.pages) - 1] as HTMLElement | undefined;
    if (row) scroller.scrollTo({ top: row.offsetTop });
  });
  modal.body.replaceChildren(el("div", { class: "proof-bar" }, stats, el("label", { class: "proof-jump small muted" }, t("proof.goto"), goto), el("span", { class: "proof-actions" }, sourceButton, fitButton, figureButton, ...downloads, zipButton, pdfButton)), tools, pdfPanel, hint, scroller);
  for (const image of list.images) {
    const slot = slots.get(image.page);
    if (slot) addThumb(slot, image.name);
  }

  /** Cuts the framed part of a page out of the PDF (drawn again for it, sharper than the page on the screen), keeps it on the server and writes its reference into the text. */
  async function cutFigure(slot: Slot, frame: { x: number; y: number; w: number; h: number }): Promise<void> {
    const say = (text: string, shown = text) => {
      slot.state.textContent = text;
      flashHint(shown);
    };
    say(t("proof.figure.cutting"));
    try {
      const page = await doc.getPage(slot.n);
      const size = page.getViewport({ scale: 1 });
      let png: Blob | null = null;
      // the sharpest picture the limits allow; if the PNG is bigger than the server takes (a whole page of a colour scan can be), again smaller
      for (let attempt = 0; attempt < MAX_ATTEMPTS && (!png || png.size > MAX_PNG_BYTES); attempt++) {
        const viewport = page.getViewport({ scale: figureScale(frame, size, attempt) });
        const canvas = el("canvas");
        canvas.width = Math.max(1, Math.round(frame.w * viewport.width));
        canvas.height = Math.max(1, Math.round(frame.h * viewport.height));
        await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -frame.x * viewport.width, -frame.y * viewport.height] }).promise;
        png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        canvas.width = canvas.height = 0;
        if (!png) break;
      }
      page.cleanup();
      if (!png || png.size > MAX_PNG_BYTES) throw new Error("no picture");
      await ensureStarted();
      const res = await fetch(`${base}/images?page=${slot.n}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/png" }, body: png });
      if (!res.ok) throw new ApiError(res.status, res.statusText);
      const image = (await res.json()) as { name: string };
      insertFigure(slot, image.name);
      addThumb(slot, image.name);
      imageCount++;
      touched = true;
      showZip();
      say(t("proof.figure.added"), t("proof.figure.addedTo", { n: slot.n }));
    } catch {
      say(t("proof.figure.failed"));
    }
  }

  /** Puts `![Fig. 8.1](images/p008-1.png)` at the cursor of the page's text, as a paragraph of its own. */
  function insertFigure(slot: Slot, name: string): void {
    const field = slot.text;
    const [, page, number] = /^p0*(\d+)-(\d+)\.png$/.exec(name) ?? [];
    const ref = `![${t("proof.figure.alt", { n: `${page}.${number}` })}](images/${name})`;
    if (slot.editor) {
      slot.editor.insert(ref); // at the cursor of the editor; the textarea follows
      return;
    }
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

  /** A small picture of a figure under the text of its page, with the buttons to put it into the text again and to delete it. */
  function addThumb(slot: Slot, name: string): void {
    const picture = el("img", { src: `${base}/images/${name}`, alt: name, title: name, loading: "lazy" });
    const insert = el("button", { type: "button", class: "btn small proof-fig-insert", textContent: t("proof.figure.insert"), title: t("proof.figure.insertTitle") });
    insert.addEventListener("click", () => {
      insertFigure(slot, name);
      if (slot.editor) slot.editor.focus();
      else slot.text.focus({ preventScroll: true });
    });
    const remove = el("button", { type: "button", class: "btn small proof-fig-delete", textContent: "×", title: t("proof.figure.delete") });
    remove.setAttribute("aria-label", t("proof.figure.delete"));
    const fig = el("figure", { class: "proof-fig" }, picture, el("div", { class: "proof-fig-actions" }, insert, remove));
    fig.dataset.name = name;
    remove.addEventListener("click", () => void removeFigure(slot, name, fig));
    slot.figs.append(fig);
  }

  /** Deletes a figure from the book; the references to it go out of the text of every page that had them. */
  async function removeFigure(slot: Slot, name: string, fig: HTMLElement): Promise<void> {
    if (!confirm(t("proof.figure.deleteAsk"))) return;
    await flush(); // what was typed is on the server before it is changed there
    try {
      const result = await api<{ pages: PageItem[] }>(`${base}/images/${name}`, undefined, "DELETE");
      for (const page of result.pages) {
        const other = slots.get(page.page);
        if (!other) continue;
        const typedSince = other.text.value !== other.sent; // typed while the request was on its way: keep it, without the reference
        other.sent = page.text;
        setText(other, typedSince ? withoutReference(other.text.value, name) : page.text);
        if (other.text.value !== other.sent) other.text.dispatchEvent(new Event("input"));
      }
      fig.remove();
      imageCount = Math.max(0, imageCount - 1);
      touched = true;
      showZip();
    } catch {
      slot.state.textContent = t("proof.figure.deleteFailed");
    }
  }

  /**
   * The frame being drawn. Its first corner is kept as shares of the picture, not as a place on the screen, because the list
   * scrolls under the pointer while the frame is drawn; `x` and `y` are where the pointer is now.
   */
  let drag: { slot: Slot; scan: HTMLElement; canvas: HTMLCanvasElement; pointer: number; fx: number; fy: number; x: number; y: number; box: HTMLElement; tick: number } | null = null;
  const stopDrag = () => {
    if (!drag) return;
    cancelAnimationFrame(drag.tick);
    drag.box.remove();
    const n = drag.slot.n;
    drag = null;
    if (!wanted.has(n)) release(n); // it was kept drawn while it was being framed, though the list had scrolled away
  };
  /** The frame in pixels of the picture on the screen, kept inside the page. */
  const frameNow = () => {
    const d = drag!;
    const rect = d.canvas.getBoundingClientRect();
    const x0 = rect.left + d.fx * rect.width;
    const y0 = rect.top + d.fy * rect.height;
    const x1 = Math.min(Math.max(d.x, rect.left), rect.right);
    const y1 = Math.min(Math.max(d.y, rect.top), rect.bottom);
    return { left: Math.min(x0, x1) - rect.left, top: Math.min(y0, y1) - rect.top, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), page: rect };
  };
  const showFrame = () => {
    const d = drag!;
    const f = frameNow();
    const scan = d.scan.getBoundingClientRect();
    Object.assign(d.box.style, { left: `${f.left + f.page.left - scan.left}px`, top: `${f.top + f.page.top - scan.top}px`, width: `${f.width}px`, height: `${f.height}px` });
  };
  /** While the pointer is at the edge of the list (or beyond it) the list scrolls, so that a frame can reach what is out of sight. */
  const follow = () => {
    if (!drag) return;
    const edge = scroller.getBoundingClientRect();
    const step = scrollStep(drag.y, edge.top, edge.bottom);
    if (step) {
      const was = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== was) showFrame();
    }
    drag.tick = requestAnimationFrame(follow);
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
    const fx = (Math.min(Math.max(e.clientX, rect.left), rect.right) - rect.left) / rect.width;
    const fy = (Math.min(Math.max(e.clientY, rect.top), rect.bottom) - rect.top) / rect.height;
    drag = { slot, scan, canvas, pointer: e.pointerId, fx, fy, x: e.clientX, y: e.clientY, box, tick: 0 };
    drag.tick = requestAnimationFrame(follow);
  });
  scroller.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    showFrame();
  });
  scroller.addEventListener("pointerup", (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const f = frameNow();
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

  /** How wide a page's picture should be to look sharp where it is now. */
  const neededWidth = (scan: HTMLElement) => Math.min(Math.round(scan.clientWidth * (devicePixelRatio || 1)), MAX_CANVAS_WIDTH);
  /** A drawn page whose picture is much smaller (blurred) or much bigger (heavy) than the room it has now. */
  const stale = (n: number) => {
    const canvas = canvases.get(n);
    const need = neededWidth(slots.get(n)!.scan);
    return !!canvas && need > 0 && (canvas.width < need * 0.85 || canvas.width > need * 1.3);
  };
  /** After the window has been stretched, draws the pages again at the size they have now (the old picture stays until the new one is ready). */
  const sharpen = () => {
    clearTimeout(sharpenTimer);
    sharpenTimer = setTimeout(() => {
      for (const n of [...canvases.keys()]) if (!closed && wanted.has(n) && stale(n)) void draw(n, true);
    }, 250);
  };

  async function draw(n: number, again = false): Promise<void> {
    if ((canvases.has(n) && !again) || drawing.has(n)) return;
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
      const old = canvases.get(n);
      scan.replaceChildren(canvas);
      setAspect(scan, canvas.width / canvas.height);
      if (old) old.width = old.height = 0;
      canvases.set(n, canvas);
      if (stale(n)) sharpen(); // the window changed again while this page was being drawn
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
    if (drag?.slot.n === n) return; // being framed: let go of it when the frame is done (stopDrag)
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
          void mountEditor(slots.get(n)!);
        } else {
          wanted.delete(n);
          release(n);
          unmountEditor(slots.get(n)!);
        }
      }
    },
    { root: scroller, rootMargin: AHEAD },
  );
  for (const row of scroller.children) observer.observe(row);
  sizeWatch = new ResizeObserver(() => {
    setFitHeight();
    sharpen();
  });
  sizeWatch.observe(scroller);
  if (store.get("tapalog.proofFit") === "1") setFit(true);
}
