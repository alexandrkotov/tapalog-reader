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

/**
 * The window for checking the text of a recognized book: every page is one row, the picture of the scan on the left and
 * the text read from it on the right, and the whole list scrolls as one, so the two never part. Pictures are drawn when a
 * row comes near the window and let go when it is far, so a book of a thousand pages costs no more than a screenful.
 */
export async function openProof(book: { id: string; title: string }): Promise<void> {
  let closed = false;
  let observer: IntersectionObserver | null = null;
  let task: Pdfjs.PDFDocumentLoadingTask | null = null;
  const finish = () => {
    closed = true;
    observer?.disconnect();
    void task?.destroy();
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

  const scroller = el("div", { class: "proof-pages" });
  const scans = new Map<number, HTMLElement>();
  const byPage = new Map(list.items.map((item) => [item.page, item]));
  for (let n = 1; n <= list.pages; n++) {
    const item = byPage.get(n);
    const scan = el("div", { class: "proof-scan" });
    scan.style.aspectRatio = String(aspect);
    const text = el("textarea", { class: "proof-text", value: item?.text ?? "", readOnly: true, spellcheck: false, placeholder: item ? "" : t("proof.unread") });
    const head = el("div", { class: "proof-head" }, el("span", { class: "proof-label", textContent: t("proof.page", { n }) }));
    if (item?.edited) head.append(el("span", { class: "proof-badge", textContent: t("proof.edited") }));
    const row = el("section", { class: "proof-row" }, scan, el("div", { class: "proof-side" }, head, text));
    row.dataset.page = String(n);
    scans.set(n, scan);
    scroller.append(row);
  }
  modal.body.replaceChildren(el("p", { class: "muted small proof-stats", textContent: t("proof.stats", { done: list.done, pages: list.pages }) }), scroller);

  const canvases = new Map<number, HTMLCanvasElement>();
  const drawing = new Set<number>();
  const wanted = new Set<number>();

  async function draw(n: number): Promise<void> {
    if (canvases.has(n) || drawing.has(n)) return;
    const scan = scans.get(n)!;
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
    scans.get(n)?.replaceChildren();
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
