import { t } from "../i18n";
import { addPlainText, type PrintJob } from "../print";
import { decodeText } from "./decode";
import { fetchBlob } from "./download";
import { createFoundMarks, type FoundMarks } from "./foundMarks";
import type { Loading } from "./loading";

/**
 * A "view" of a plain-text file: the character at the top of the window and, optionally,
 * a marked passage. Offsets are in UTF-16 units of the decoded text, so they are the same
 * in any window size or font size.
 */
export interface TxtView {
  v: 1;
  offset: number;
  range?: [number, number];
}

export interface TxtOptions {
  url: string;
  view?: TxtView | null;
  onView(view: TxtView): void;
  onError(error: Error): void;
  /** Tells how much of the file has come, while it is on its way. */
  loading?: Loading;
  /** Words a search found: marked in the text. */
  find?: string[];
}

export interface TxtReader {
  destroy(): void;
  getView(): TxtView;
  /** A name for the place on screen: how far into the text. */
  getLabel(): string;
  /** The passage the reader has selected (or, failing that, marked): a view that opens with it marked, and its text. */
  getPassage(): { view: TxtView; quote: string } | null;
  printJob(): PrintJob;
}

const VIEW_DEBOUNCE_MS = 250;
const FONT_STEP = 10;
const FONT_MIN = 70;
const FONT_MAX = 250;
const MARK_COLOR = "rgba(255, 179, 0, 0.45)";

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

const clampInt = (n: unknown, max: number): number | null => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max ? n : null);

/** A view from a link is untrusted input: keep only integers that fit the text. */
function cleanView(view: TxtView | null | undefined, length: number): { offset: number; range: [number, number] | null } {
  const offset = clampInt(view?.offset, length) ?? 0;
  const a = clampInt(view?.range?.[0], length);
  const b = clampInt(view?.range?.[1], length);
  return { offset, range: a !== null && b !== null && a < b ? [a, b] : null };
}

export async function mountTxt(host: HTMLElement, options: TxtOptions): Promise<TxtReader> {
  let fontPct = Math.min(FONT_MAX, Math.max(FONT_MIN, Number(read("tr.txt.font")) || 100));
  let text = "";
  let mark: [number, number] | null = null;
  let destroyed = false;
  let lastSent = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.className = "txt-reader";
  const progress = document.createElement("span");
  progress.className = "pdf-zoom book-progress";
  const spacer = document.createElement("span");
  spacer.className = "book-chapter";
  const fontLabel = document.createElement("span");
  fontLabel.className = "pdf-zoom";
  const markButton = button("✎ " + t("book.mark"), t("book.markHint"), () => markSelection());
  markButton.disabled = true;
  const clearButton = button("✕ " + t("book.clearMark"), t("book.clearMark"), () => setMark(null));
  clearButton.hidden = true;
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar book-toolbar";
  toolbar.append(progress, spacer, button("A−", t("book.smaller"), () => setFont(fontPct - FONT_STEP)), fontLabel, button("A+", t("book.larger"), () => setFont(fontPct + FONT_STEP)), markButton, clearButton);
  const frame = document.createElement("div");
  frame.className = "book-frame";
  const scroller = document.createElement("div");
  scroller.className = "txt-scroll";
  scroller.tabIndex = 0;
  const body = document.createElement("div");
  body.className = "txt-body";
  scroller.append(body);
  frame.append(scroller);
  root.append(toolbar, frame);
  host.append(root);

  // ---------- text <-> offsets ----------
  /** The text is one to three text nodes (before / marked / after) under `body`. */
  function textNodes(): Text[] {
    return [...body.childNodes].flatMap((n) => (n.nodeType === Node.TEXT_NODE ? [n as Text] : [...n.childNodes].filter((c): c is Text => c.nodeType === Node.TEXT_NODE)));
  }

  function nodeAt(offset: number): { node: Text; offset: number } | null {
    let rest = offset;
    const nodes = textNodes();
    for (const node of nodes) {
      if (rest <= node.length) return { node, offset: rest };
      rest -= node.length;
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last, offset: last.length } : null;
  }

  function offsetOf(node: Node, within: number): number | null {
    let total = 0;
    for (const n of textNodes()) {
      if (n === node) return total + within;
      total += n.length;
    }
    return null;
  }

  function rectAt(offset: number): DOMRect | null {
    const pos = nodeAt(offset);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.node, pos.offset);
    r.collapse(true);
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    return rect.height || rect.width ? rect : (pos.node.parentElement?.getBoundingClientRect() ?? null);
  }

  /** Scrolls so the character at `offset` is on the first line of the window. */
  function scrollToOffset(offset: number, centre = false) {
    const rect = rectAt(offset);
    if (!rect) return;
    const top = scroller.getBoundingClientRect().top;
    const shift = centre ? scroller.clientHeight / 2 : 8;
    scroller.scrollTop += rect.top - top - shift;
  }

  /** The offset of the character at the top-left of the window. */
  function topOffset(): number {
    const box = scroller.getBoundingClientRect();
    const x = box.left + box.width / 2;
    for (const dy of [12, 24, 40]) {
      const y = box.top + dy;
      let node: Node | null = null;
      let off = 0;
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) [node, off] = [p.offsetNode, p.offset];
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) [node, off] = [r.startContainer, r.startOffset];
      }
      const at = node ? offsetOf(node, off) : null;
      if (at !== null) return at;
    }
    return 0;
  }

  // ---------- rendering ----------
  function render() {
    body.replaceChildren();
    if (!mark) {
      body.append(document.createTextNode(text));
    } else {
      const m = document.createElement("mark");
      m.textContent = text.slice(mark[0], mark[1]);
      m.style.background = MARK_COLOR;
      m.style.color = "inherit";
      body.append(document.createTextNode(text.slice(0, mark[0])), m, document.createTextNode(text.slice(mark[1])));
    }
    clearButton.hidden = !mark;
  }

  function setFont(pct: number) {
    const before = topOffset();
    fontPct = Math.min(FONT_MAX, Math.max(FONT_MIN, pct));
    write("tr.txt.font", String(fontPct));
    fontLabel.textContent = `${fontPct}%`;
    scroller.style.setProperty("--txt-size", String(fontPct / 100));
    if (text) scrollToOffset(before);
  }

  function setMark(next: [number, number] | null) {
    const before = topOffset();
    mark = next;
    render();
    scrollToOffset(before);
    emit();
  }

  function markSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const a = offsetOf(r.startContainer, r.startOffset);
    const b = offsetOf(r.endContainer, r.endOffset);
    sel.removeAllRanges();
    markButton.disabled = true;
    if (a !== null && b !== null && a !== b) setMark([Math.min(a, b), Math.max(a, b)]);
  }

  function passage(): { view: TxtView; quote: string } | null {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && body.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      const r = sel.getRangeAt(0);
      const a = offsetOf(r.startContainer, r.startOffset);
      const b = offsetOf(r.endContainer, r.endOffset);
      if (a !== null && b !== null && a !== b) {
        const range: [number, number] = [Math.min(a, b), Math.max(a, b)];
        return { view: { v: 1, offset: topOffset(), range }, quote: text.slice(range[0], range[1]) };
      }
    }
    return mark ? { view: currentView(), quote: text.slice(mark[0], mark[1]) } : null;
  }

  // ---------- view reporting ----------
  function currentView(): TxtView {
    return { v: 1, offset: topOffset(), ...(mark ? { range: [...mark] as [number, number] } : {}) };
  }

  function updateProgress() {
    const max = scroller.scrollHeight - scroller.clientHeight;
    progress.textContent = `${max > 0 ? Math.round((scroller.scrollTop / max) * 100) : 100}%`;
  }

  /** Tells the shell what is on screen, at most every 250 ms and never twice the same. */
  function emit() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (destroyed) return;
      const v = currentView();
      const key = JSON.stringify(v);
      if (key === lastSent) return;
      lastSent = key;
      options.onView(v);
    }, VIEW_DEBOUNCE_MS);
  }

  scroller.addEventListener("scroll", () => {
    updateProgress();
    emit();
  });
  const onSelection = () => {
    const sel = getSelection();
    markButton.disabled = !(sel && !sel.isCollapsed && sel.rangeCount && body.contains(sel.getRangeAt(0).commonAncestorContainer));
  };
  document.addEventListener("selectionchange", onSelection);
  const onResize = new ResizeObserver(() => updateProgress());
  onResize.observe(scroller);

  // ---------- open ----------
  let found: FoundMarks | null = null;
  try {
    text = decodeText(new Uint8Array(await (await fetchBlob(options.url, (p) => options.loading?.update(p))).arrayBuffer()));
    options.loading?.opening();
    if (destroyed) return { destroy() {}, getView: () => ({ v: 1, offset: 0 }), getLabel: () => "", getPassage: () => null, printJob: () => ({ choices: [], render: async () => undefined }) };
    const initial = cleanView(options.view, text.length);
    mark = initial.range;
    render();
    found = createFoundMarks(options.find);
    found?.add("text", body);
    setFont(fontPct);
    // Layout has to settle before the offset can be turned into a scroll position.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (mark) scrollToOffset(mark[0], true);
    else if (initial.offset > 0) scrollToOffset(initial.offset);
    updateProgress();
    scroller.focus();
  } catch (err) {
    options.onError(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelection);
      onResize.disconnect();
      found?.clear();
      root.remove();
    },
    getView: currentView,
    getPassage: passage,
    getLabel: () => progress.textContent ?? "",
    printJob: () => ({
      choices: [...(mark ? [{ id: "mark", label: t("print.mark") }] : []), { id: "all", label: t("print.text") }],
      async render(choice, _range, ctx) {
        addPlainText(ctx.root, choice === "mark" && mark ? text.slice(mark[0], mark[1]) : text);
      },
    }),
  };
}
