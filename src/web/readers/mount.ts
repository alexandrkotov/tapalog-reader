import { createPdfExporter, mountViewerInShadow, type EcatmView } from "@ecm/viewer-engine";
import wasmUrl from "@ecm/viewer-engine/sql-wasm.wasm";
import pdfFontUrl from "@ecm/viewer-engine/fonts/DejaVuSans.ttf";
import { t } from "../i18n";
import { isDark, onTheme } from "../theme";
import type { PrintJob } from "../print";
import { el } from "../ui";
import type { PageView } from "./types";
import type { TextView } from "./book";
import type { TxtView } from "./txt";
import type { Display } from "../display";
import { mountPlugin, pluginError, pluginFor } from "./plugins";

/** What the shell needs from whichever reader shows a book. */
export interface Reader {
  destroy(): void;
  /** The current view (page, position, highlighted area), for formats that have one. */
  getView?(): unknown;
  /** A suggested name for a bookmark at the current place, when one can be worked out. */
  getLabel?(): string;
  /** The passage the reader has selected or marked, for text formats: a view that opens with it marked, and its words. */
  getPassage?(): { view: unknown; quote: string } | null;
  /** What can be printed or saved as PDF, for formats that can do it (not catalogs: their viewer exports PDF itself). */
  printJob?(): PrintJob;
}

export interface ReaderSpec {
  name: string;
  ext: string;
  /** Where the file bytes come from: the library file or a share link's file. */
  fileUrl: string;
  /** A view to open at, in the shape the format uses (EcatmView for catalogs, PageView for PDF). */
  view: unknown;
  /** Called with the current view whenever it changes (at most every 250 ms). */
  onView?(view: unknown): void;
  /** How this reader likes to see the book (paged documents use it), and the call that remembers a change. */
  display?: Display;
  onDisplay?(display: Display): void;
  onError(title: string, text: string): void;
}

/** Built-in formats whose readers report a view the user can share. */
const VIEW_FORMATS = new Set(["pdf", "ecatm", "epub", "fb2", "mobi", "txt"]);

/** Whether the reader for this format reports a view that a share link can carry (a plugin's reader says so in its manifest). */
export const hasShareableView = (ext: string): boolean => VIEW_FORMATS.has(ext) || pluginFor(ext)?.shareableView === true;

/** Formats shown by the text engine (foliate-js). */
const TEXT_FORMATS = new Set(["epub", "fb2", "mobi", "cbz"]);


/** Mounts the right reader for the book's format into `host`. */
export async function mountReader(host: HTMLElement, spec: ReaderSpec): Promise<Reader> {
  if (spec.ext === "ecatm") {
    const viewer = mountViewerInShadow(host, {
      mode: "reader",
      wasmUrl,
      exportPdf: createPdfExporter(pdfFontUrl),
      theme: isDark() ? "dark" : "light",
      persist: false,
      analytics: false,
      regionSelect: true,
      onEvent: (type, detail) => {
        if (type === "view") spec.onView?.(detail);
      },
    });
    void viewer.openUrl(spec.fileUrl, { fetchInit: { credentials: "include" }, view: (spec.view as EcatmView | null) ?? undefined }).catch((err: unknown) => {
      spec.onError(t("catalog.error"), err instanceof Error ? err.message : String(err));
    });
    const stopTheme = onTheme(() => viewer.setTheme(isDark() ? "dark" : "light"));
    return { destroy: () => (stopTheme(), viewer.destroy()), getView: () => viewer.getView() };
  }

  if (spec.ext === "pdf") {
    // Loaded on first use: pdf.js is ~1 MB the catalog and text readers never need.
    const { mountPdf } = await import("./pdf");
    const reader = await mountPdf(host, {
      url: spec.fileUrl,
      view: spec.view as PageView | null,
      onView: (v) => spec.onView?.(v),
      display: spec.display ?? {},
      onDisplay: (d) => spec.onDisplay?.(d),
      onError: (err) => spec.onError(t("pdf.error"), err.message),
    });
    return { destroy: () => reader.destroy(), getView: () => reader.getView(), getLabel: () => reader.getLabel(), printJob: () => reader.printJob() };
  }

  if (spec.ext === "txt") {
    const { mountTxt } = await import("./txt");
    const reader = await mountTxt(host, {
      url: spec.fileUrl,
      view: spec.view as TxtView | null,
      onView: (v) => spec.onView?.(v),
      onError: (err) => spec.onError(t("book.error"), err.message),
    });
    return { destroy: () => reader.destroy(), getView: () => reader.getView(), getLabel: () => reader.getLabel(), getPassage: () => reader.getPassage(), printJob: () => reader.printJob() };
  }

  if (TEXT_FORMATS.has(spec.ext)) {
    // Loaded on first use, like pdf.js: the text engine is only needed for these formats.
    const { mountBook } = await import("./book");
    const reader = await mountBook(host, {
      url: spec.fileUrl,
      ext: spec.ext,
      view: spec.view as TextView | null,
      onView: (v) => spec.onView?.(v),
      onError: (err) => spec.onError(t("book.error"), err.message),
    });
    return { destroy: () => reader.destroy(), getView: () => reader.getView(), getLabel: () => reader.getLabel(), getPassage: () => reader.getPassage(), printJob: () => reader.printJob() };
  }

  const plugin = pluginFor(spec.ext); // after the built-in readers: a plugin adds formats, it does not replace what the program already opens
  if (plugin) {
    try {
      return await mountPlugin(host, plugin, spec);
    } catch (err) {
      spec.onError(pluginError(), err instanceof Error ? err.message : String(err));
      return { destroy: () => host.replaceChildren() };
    }
  }

  const box = el("div", { class: "message" }, el("h2", { textContent: spec.name }), el("p", { textContent: t("reader.soon", { fmt: spec.ext.toUpperCase() }) }), el("a", { class: "button", href: spec.fileUrl, textContent: t("reader.download") }));
  host.replaceChildren(box);
  return { destroy: () => box.remove() };
}
