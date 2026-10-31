import { createPdfExporter, mountViewerInShadow, type EcatmView } from "@ecm/viewer-engine";
import wasmUrl from "@ecm/viewer-engine/sql-wasm.wasm";
import pdfFontUrl from "@ecm/viewer-engine/fonts/DejaVuSans.ttf";
import { t } from "../i18n";
import { el } from "../ui";
import type { PageView } from "./types";

/** What the shell needs from whichever reader shows a book. */
export interface Reader {
  destroy(): void;
  /** The current view (page, position, highlighted area), for formats that have one. */
  getView?(): unknown;
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
  onError(title: string, text: string): void;
}

/** Formats whose readers report a view the user can share. */
export const VIEW_FORMATS = new Set(["pdf", "ecatm"]);

const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

/** Mounts the right reader for the book's format into `host`. */
export async function mountReader(host: HTMLElement, spec: ReaderSpec): Promise<Reader> {
  if (spec.ext === "ecatm") {
    const viewer = mountViewerInShadow(host, {
      mode: "reader",
      wasmUrl,
      exportPdf: createPdfExporter(pdfFontUrl),
      theme: dark() ? "dark" : "light",
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
    return { destroy: () => viewer.destroy(), getView: () => viewer.getView() };
  }

  if (spec.ext === "pdf") {
    // Loaded on first use: pdf.js is ~1 MB the catalog and text readers never need.
    const { mountPdf } = await import("./pdf");
    const reader = await mountPdf(host, {
      url: spec.fileUrl,
      view: spec.view as PageView | null,
      onView: (v) => spec.onView?.(v),
      onError: (err) => spec.onError(t("pdf.error"), err.message),
    });
    return { destroy: () => reader.destroy(), getView: () => reader.getView() };
  }

  const box = el("div", { class: "message" }, el("h2", { textContent: spec.name }), el("p", { textContent: t("reader.soon", { fmt: spec.ext.toUpperCase() }) }), el("a", { class: "button", href: spec.fileUrl, textContent: t("reader.download") }));
  host.replaceChildren(box);
  return { destroy: () => box.remove() };
}
