import { t } from "./i18n";
import { el, openModal } from "./ui";

/**
 * Print and "save as PDF". The browser's own print window does both (its "Save as PDF" printer
 * writes a real file with selectable text), so nothing here makes a PDF itself: a reader says
 * what can be printed and fills a hidden page with it, and this module prints that page.
 */

export interface PrintChoice {
  id: string;
  label: string;
  /** Pages (or chapters) from..to, 1-based: shows two number fields. */
  range?: { max: number; from: number };
}

export interface PrintContext {
  /** Where the printout goes. It is a shadow tree, so a book's own CSS cannot touch the app (or the other way round). */
  root: ShadowRoot;
  signal: AbortSignal;
  progress(done: number, total: number): void;
  /** Runs when the printout is thrown away (revoke object URLs, release book resources). */
  onCleanup(fn: () => void): void;
}

export interface PrintJob {
  choices: PrintChoice[];
  /** The choice selected first; the first one when absent. */
  initial?: string;
  render(choice: string, range: [number, number] | null, ctx: PrintContext): Promise<void>;
}

const BASE_CSS = `
  :host { display: block; background: #fff; color: #000; font: 11pt/1.45 Georgia, "Times New Roman", serif; }
  .section + .section { break-before: page; }
  img, svg, video, canvas { max-width: 100%; height: auto; break-inside: avoid; }
  .page-image { display: block; margin: 0 auto; max-width: 100%; max-height: 250mm; break-after: page; break-inside: avoid; }
  .page-image:last-child { break-after: auto; }
  pre.plain { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 10.5pt/1.4 ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; }
`;

let cleanups: (() => void)[] = [];
let rootEl: HTMLElement | null = null;

/** Removes the printout and lets go of everything it held. Safe to call at any time. */
export function clearPrint(): void {
  rootEl?.remove();
  rootEl = null;
  document.body.classList.remove("printing");
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* a resource that is already gone */
    }
  }
}

function newTarget(): { root: ShadowRoot; ctx: Pick<PrintContext, "root" | "onCleanup"> } {
  clearPrint();
  rootEl = el("div", { id: "print-root" });
  const root = rootEl.attachShadow({ mode: "open" });
  root.append(el("style", { textContent: BASE_CSS }));
  document.body.append(rootEl);
  return { root, ctx: { root, onCleanup: (fn) => void cleanups.push(fn) } };
}

/** Tags and attributes that could run something or reach out; the page's CSP also blocks scripts, this is the second lock. */
const DROP = "script, iframe, frame, frameset, object, embed, applet, base, meta, noscript, form, input, button, select, textarea, link:not([rel~='stylesheet'])";
const URL_ATTRS = ["href", "src", "xlink:href", "action", "formaction"];

function clean(node: Element): void {
  for (const attr of [...node.attributes]) {
    if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    else if (URL_ATTRS.includes(attr.name.toLowerCase()) && /^\s*(javascript|data:text\/html|vbscript):/i.test(attr.value)) node.removeAttribute(attr.name);
  }
}

/**
 * Adds one section of a book (an HTML or XHTML document whose pictures and style sheets are already
 * object URLs) to the printout. The book is third-party content: scripts, frames and handlers are
 * stripped before anything is imported into the page.
 */
export function addHtmlSection(root: ShadowRoot, source: string, type: string): void {
  let doc = new DOMParser().parseFromString(source, type as DOMParserSupportedType);
  if (doc.querySelector("parsererror") || !doc.documentElement) doc = new DOMParser().parseFromString(source, "text/html");
  for (const node of doc.querySelectorAll(DROP)) node.remove();
  for (const node of doc.querySelectorAll("*")) clean(node);
  const section = el("div", { class: "section" });
  for (const node of doc.querySelectorAll("head style, head link")) section.append(document.importNode(node, true));
  for (const node of doc.body ? [...doc.body.childNodes] : []) section.append(document.importNode(node, true));
  root.append(section);
}

export function addPlainText(root: ShadowRoot, text: string): void {
  root.append(el("pre", { class: "plain", textContent: text }));
}

export function addPageImage(root: ShadowRoot, url: string): void {
  root.append(el("img", { class: "page-image", src: url, alt: "" }));
}

/** Asks what to print, prepares it, and opens the browser's print window. */
export function openPrintDialog(options: { name?: string; fileUrl?: string; job: PrintJob }): void {
  const { job } = options;
  let busy: AbortController | null = null;
  const modal = openModal(t("print.title"), () => busy?.abort());

  let choice = job.initial ?? job.choices[0]!.id;
  const rangeFor = (id: string) => job.choices.find((c) => c.id === id)?.range;
  const from = el("input", { type: "number", min: "1", class: "pdf-page-input" });
  const to = el("input", { type: "number", min: "1", class: "pdf-page-input" });
  const rangeBox = el("div", { class: "row print-range" }, from, el("span", { textContent: t("print.to") }), to);
  const status = el("div", { class: "muted", role: "status" });

  const radios = job.choices.map((c) => {
    const radio = el("input", { type: "radio", name: "print-choice", value: c.id, checked: c.id === choice });
    radio.addEventListener("change", () => {
      choice = c.id;
      sync();
    });
    return el("label", { class: "print-choice" }, radio, c.label);
  });

  function sync(): void {
    const r = rangeFor(choice);
    rangeBox.hidden = !r;
    if (r) {
      from.max = to.max = String(r.max);
      if (!from.value) from.value = String(r.from);
      if (!to.value) to.value = String(r.max);
    }
  }

  const go = el("button", { type: "button", class: "btn primary", textContent: t("print.go") });
  const cancel = el("button", { type: "button", class: "btn", textContent: t("print.cancel") });
  const download = options.fileUrl ? el("a", { class: "muted", href: options.fileUrl, download: options.name ?? "", textContent: t("print.download") }) : null; // what is not a file (a project) has no original to download
  modal.body.append(
    el("div", { class: "muted", textContent: t("print.what") }),
    el("div", { class: "print-choices" }, ...radios),
    rangeBox,
    el("div", { class: "muted small", textContent: t("print.hint") }),
    status,
    el("div", { class: "row" }, go, cancel, el("span", { class: "grow" }), ...(download ? [download] : [])),
  );
  sync();

  const lock = (on: boolean) => {
    for (const node of modal.body.querySelectorAll<HTMLInputElement>("input")) node.disabled = on;
    go.disabled = on;
  };

  const rangeValue = (): [number, number] | null => {
    const r = rangeFor(choice);
    if (!r) return null;
    const a = Math.min(r.max, Math.max(1, Math.round(Number(from.value)) || 1));
    const b = Math.min(r.max, Math.max(1, Math.round(Number(to.value)) || r.max));
    return [Math.min(a, b), Math.max(a, b)];
  };

  cancel.addEventListener("click", () => modal.close());

  go.addEventListener("click", async () => {
    const mine = (busy = new AbortController());
    const { signal } = mine;
    lock(true);
    const { root, ctx } = newTarget();
    try {
      await options.job.render(choice, rangeValue(), { ...ctx, signal, progress: (done, total) => (status.textContent = t("print.working", { done, total })) });
      if (signal.aborted) return clearPrint();
      await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
      if (signal.aborted) return clearPrint();
      busy = null;
      modal.close();
      document.body.classList.add("printing");
      addEventListener("afterprint", clearPrint, { once: true });
      window.print();
    } catch (err) {
      clearPrint();
      if (signal.aborted) return;
      lock(false);
      status.textContent = t("print.error", { msg: err instanceof Error ? err.message : String(err) });
    }
  });
}
