import "foliate-js/view.js";
import { Overlayer } from "foliate-js/overlayer.js";
import { t } from "../i18n";

/**
 * A "view" of reflowable text (EPUB, FB2, MOBI): where the reader is, and optionally a
 * marked passage. Both are EPUB CFIs, which name a place in the text rather than a
 * page, so they survive a different window size or font size.
 */
export interface TextView {
  v: 1;
  /** Start of what is on screen. */
  cfi?: string;
  /** The marked passage, as a range CFI. */
  range?: string;
  /** Where to open when there is no CFI (search results use these): a spine item, counted from 0, or how far into the book (0..1). */
  section?: number;
  fraction?: number;
}

export interface BookOptions {
  url: string;
  ext: string;
  view?: TextView | null;
  onView(view: TextView): void;
  onError(error: Error): void;
}

export interface BookReader {
  destroy(): void;
  getView(): TextView | null;
}

interface TocItem {
  label?: string;
  href?: string;
  subitems?: TocItem[];
}

interface Location {
  cfi: string;
  fraction: number;
  tocItem?: { label?: string };
}

interface FoliateRenderer extends HTMLElement {
  setStyles?(css: string): void;
  getContents(): { doc: Document; index: number }[];
}

interface FoliateView extends HTMLElement {
  renderer: FoliateRenderer;
  book: { toc?: TocItem[] };
  lastLocation: Location | null;
  isFixedLayout: boolean;
  open(book: File): Promise<void>;
  close(): void;
  init(options: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
  goTo(target: string | number): Promise<unknown>;
  goToFraction(fraction: number): Promise<void>;
  goToTextStart(): Promise<unknown>;
  prev(): Promise<void>;
  next(): Promise<void>;
  getCFI(index: number, range: Range): string;
  resolveNavigation(target: string): { index: number } | undefined;
  addAnnotation(annotation: { value: string }, remove?: boolean): Promise<unknown>;
}

const MIME: Record<string, string> = {
  epub: "application/epub+zip",
  fb2: "application/x-fictionbook+xml",
  mobi: "application/x-mobipocket-ebook",
  cbz: "application/vnd.comicbook+zip",
};
const VIEW_DEBOUNCE_MS = 250;
const MARK_COLOR = "#ffb300";
const FONT_STEP = 10;
const FONT_MIN = 70;
const FONT_MAX = 250;
const CFI_RE = /^epubcfi\(.{1,900}\)$/;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window: the setting just won't be remembered */
  }
};

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

/** A view that came from a link is untrusted input: keep only what looks like CFIs and a fraction. */
function cleanView(view: TextView | null | undefined): TextView | null {
  if (!view || typeof view !== "object") return null;
  const cfi = typeof view.cfi === "string" && CFI_RE.test(view.cfi) ? view.cfi : undefined;
  const range = typeof view.range === "string" && CFI_RE.test(view.range) ? view.range : undefined;
  const fraction = typeof view.fraction === "number" && view.fraction >= 0 && view.fraction <= 1 ? view.fraction : undefined;
  const section = Number.isInteger(view.section) && view.section! >= 0 && view.section! < 100000 ? view.section : undefined;
  if (!cfi && !range && fraction === undefined && section === undefined) return null;
  return { v: 1, ...(cfi ? { cfi } : {}), ...(range ? { range } : {}), ...(section !== undefined ? { section } : {}), ...(fraction !== undefined ? { fraction } : {}) };
}

/** Only these may be opened from a link inside a book; `javascript:` and friends are dropped. */
const SAFE_LINK = /^(https?:|mailto:)/i;

export async function mountBook(host: HTMLElement, options: BookOptions): Promise<BookReader> {
  const initial = cleanView(options.view);
  let fontPct = Math.min(FONT_MAX, Math.max(FONT_MIN, Number(read("tr.book.font")) || 100));
  let flow: "paginated" | "scrolled" = read("tr.book.flow") === "scrolled" ? "scrolled" : "paginated";
  let mark: string | null = initial?.range ?? null;
  let markIndex: number | null = null;
  let selection: { index: number; range: Range } | null = null;
  let destroyed = false;
  let lastSent = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.className = "book-reader";
  const progress = document.createElement("span");
  progress.className = "pdf-zoom book-progress";
  const chapter = document.createElement("span");
  chapter.className = "book-chapter";
  const fontLabel = document.createElement("span");
  fontLabel.className = "pdf-zoom";
  const tocButton = button("☰", t("book.toc"), () => toc.classList.toggle("open"));
  const flowButton = button("", t("book.flow"), () => {
    flow = flow === "paginated" ? "scrolled" : "paginated";
    write("tr.book.flow", flow);
    applyFlow();
  });
  const markButton = button("✎ " + t("book.mark"), t("book.markHint"), () => markSelection());
  markButton.disabled = true;
  const clearButton = button("✕ " + t("book.clearMark"), t("book.clearMark"), () => void setMark(null));
  clearButton.hidden = true;
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar book-toolbar";
  toolbar.append(
    tocButton,
    button("‹", t("book.prev"), () => void view.prev()),
    button("›", t("book.next"), () => void view.next()),
    progress,
    chapter,
    button("A−", t("book.smaller"), () => setFont(fontPct - FONT_STEP)),
    fontLabel,
    button("A+", t("book.larger"), () => setFont(fontPct + FONT_STEP)),
    flowButton,
    markButton,
    clearButton,
  );
  const frame = document.createElement("div");
  frame.className = "book-frame";
  const toc = document.createElement("nav");
  toc.className = "book-toc";
  toc.setAttribute("aria-label", t("book.toc"));
  const view = document.createElement("foliate-view") as FoliateView;
  frame.append(toc, view);
  root.append(toolbar, frame);
  host.append(root);

  // ---------- helpers ----------
  const css = () => `
    html { color-scheme: light dark; font-size: ${fontPct}% !important; }
    @media (prefers-color-scheme: dark) { a:link { color: lightblue; } a:visited { color: #c8a8e8; } }
    p, li, blockquote, dd { line-height: 1.5; }
  `;

  function applyFlow() {
    view.renderer.setAttribute("flow", flow);
    flowButton.textContent = flow === "paginated" ? "▤" : "☷";
    flowButton.title = t(flow === "paginated" ? "book.toScroll" : "book.toPages");
    flowButton.setAttribute("aria-label", flowButton.title);
  }

  function setFont(pct: number) {
    fontPct = Math.min(FONT_MAX, Math.max(FONT_MIN, pct));
    write("tr.book.font", String(fontPct));
    fontLabel.textContent = `${fontPct}%`;
    view.renderer.setStyles?.(css());
  }

  function currentView(): TextView | null {
    const cfi = view.lastLocation?.cfi;
    if (!cfi) return null;
    return { v: 1, cfi, ...(mark ? { range: mark } : {}) };
  }

  /** Tells the shell what is on screen, at most every 250 ms and never twice the same. */
  function emit() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const v = currentView();
      if (!v || destroyed) return;
      const key = JSON.stringify(v);
      if (key === lastSent) return;
      lastSent = key;
      options.onView(v);
    }, VIEW_DEBOUNCE_MS);
  }

  async function paintMark() {
    if (!mark) return;
    try {
      await view.addAnnotation({ value: mark });
    } catch {
      /* books without a TOC throw after the highlight is drawn; nothing to undo */
    }
  }

  async function setMark(cfi: string | null) {
    const old = mark;
    mark = cfi;
    markIndex = cfi ? (view.resolveNavigation(cfi)?.index ?? null) : null;
    if (old) await view.addAnnotation({ value: old }, true).catch(() => undefined);
    clearButton.hidden = !mark;
    await paintMark();
    emit();
  }

  function markSelection() {
    if (!selection) return;
    const cfi = view.getCFI(selection.index, selection.range);
    selection.range.commonAncestorContainer.ownerDocument?.getSelection()?.removeAllRanges();
    selection = null;
    markButton.disabled = true;
    void setMark(cfi);
  }

  function buildToc(items: TocItem[], depth = 0): HTMLElement {
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = (item.label ?? "").trim() || "—";
      a.style.paddingInlineStart = `${8 + depth * 14}px`;
      a.href = "#";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (item.href) void view.goTo(item.href);
        toc.classList.remove("open");
      });
      li.append(a);
      if (item.subitems?.length) li.append(buildToc(item.subitems, depth + 1));
      ul.append(li);
    }
    return ul;
  }

  function onKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") void view.prev();
    else if (e.key === "ArrowRight" || e.key === "PageDown") void view.next();
    else return;
    e.preventDefault();
  }

  // ---------- events ----------
  view.addEventListener("relocate", (e) => {
    const loc = (e as CustomEvent<Location>).detail;
    progress.textContent = `${Math.round((loc.fraction ?? 0) * 100)}%`;
    chapter.textContent = loc.tocItem?.label?.trim() ?? "";
    emit();
  });
  view.addEventListener("load", (e) => {
    const { doc, index } = (e as CustomEvent<{ doc: Document; index: number }>).detail;
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("selectionchange", () => {
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        selection = { index, range: sel.getRangeAt(0) };
        markButton.disabled = false;
      } else if (selection?.index === index) {
        selection = null;
        markButton.disabled = true;
      }
    });
  });
  view.addEventListener("create-overlay", (e) => {
    if (mark && markIndex === (e as CustomEvent<{ index: number }>).detail.index) void paintMark();
  });
  view.addEventListener("draw-annotation", (e) => {
    const { draw } = (e as CustomEvent<{ draw: (fn: unknown, opts: unknown) => void }>).detail;
    draw(Overlayer.highlight, { color: MARK_COLOR });
  });
  // Links inside a book are the book's author's, not ours: never let one run script in this origin.
  view.addEventListener("external-link", (e) => {
    e.preventDefault();
    const { href_ } = (e as CustomEvent<{ href_: string }>).detail;
    if (SAFE_LINK.test(href_)) window.open(href_, "_blank", "noopener,noreferrer");
  });
  root.addEventListener("keydown", onKey);

  // ---------- open ----------
  try {
    const res = await fetch(options.url, { credentials: "include" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const file = new File([await res.blob()], `book.${options.ext}`, { type: MIME[options.ext] ?? "" });
    await view.open(file);
    if (destroyed) return { destroy() {}, getView: () => null };
    applyFlow();
    setFont(fontPct);
    // Comics are pictures: text size, flow and passage marks mean nothing there.
    if (view.isFixedLayout) for (const b of [fontLabel, flowButton, markButton, ...toolbar.querySelectorAll<HTMLElement>("button[title='" + t("book.smaller") + "'], button[title='" + t("book.larger") + "']")]) b.hidden = true;
    if (view.book.toc?.length) toc.append(buildToc(view.book.toc));
    else tocButton.hidden = true;
    markIndex = mark ? (view.resolveNavigation(mark)?.index ?? null) : null;
    clearButton.hidden = !mark;
    try {
      await view.init({ lastLocation: initial?.range ?? initial?.cfi ?? null, showTextStart: true });
      if (!initial?.range && !initial?.cfi) {
        if (initial?.section !== undefined) await view.goTo(initial.section);
        else if (initial?.fraction !== undefined) await view.goToFraction(initial.fraction);
      }
    } catch {
      await view.goToTextStart();
    }
    await paintMark();
  } catch (err) {
    options.onError(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      try {
        view.close();
      } catch {
        /* never opened */
      }
      root.remove();
    },
    getView: currentView,
  };
}
