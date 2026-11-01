import * as pdfjsLib from "pdfjs-dist/build/pdf.min.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { t } from "../i18n";
import { addPageImage, type PrintJob } from "../print";
import { mountThumbs, type Thumbs } from "./thumbs";
import type { PageView, ReaderHandle, Rect } from "./types";

/** pdf.js' own padding around the page column; "zoom 1" is the page width that leaves exactly this. */
const SCROLLBAR_PADDING = 40;
const MAX_SCALE = 8;
const MIN_SCALE = 0.1;
const MIN_REGION = 0.005;
const VIEW_DEBOUNCE_MS = 250;
/** Printed pages are drawn this many pixels wide (about 200 dpi on A4): sharp on paper, a few hundred KB each. */
const PRINT_PAGE_PX = 1700;
const PRINT_MAX_SIDE = 4096;
const THUMB_PX = 132;
const THUMBS_KEY = "tr.pdf.thumbs";

const remembered = (): boolean => {
  try {
    return localStorage.getItem(THUMBS_KEY) === "1" && !matchMedia("(max-width: 720px)").matches;
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    localStorage.setItem(THUMBS_KEY, on ? "1" : "0");
  } catch {
    /* not persisted */
  }
};

export interface PdfReader extends ReaderHandle {
  getView(): PageView;
  setView(view: PageView): void;
  printJob(): PrintJob;
}

export interface PdfOptions {
  url: string;
  view?: PageView | null;
  /** Called when what is on screen changes, at most every 250 ms and never twice with the same view. */
  onView(view: PageView): void;
  onError(error: Error): void;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 10000) / 10000;

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

export async function mountPdf(host: HTMLElement, options: PdfOptions): Promise<PdfReader> {
  // pdf_viewer.mjs reads `globalThis.pdfjsLib` while it loads, so the library has to be published first.
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const { PDFViewer, EventBus, PDFLinkService } = await import("pdfjs-dist/web/pdf_viewer.mjs");

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.className = "pdf-reader";
  const pageInput = document.createElement("input");
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.className = "pdf-page-input";
  pageInput.setAttribute("aria-label", "Page");
  const pageCount = document.createElement("span");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "pdf-zoom";
  const thumbsButton = button("▥", t("pages.toggle"), () => void setThumbs(!thumbs));
  thumbsButton.setAttribute("aria-label", t("pages.toggle"));
  const areaButton = button("▭ Area", "Select a rectangle and highlight it (shareable)", () => setSelecting(!selecting));
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  toolbar.append(
    thumbsButton,
    button("‹", "Previous page", () => pdfViewer.previousPage()),
    pageInput,
    pageCount,
    button("›", "Next page", () => pdfViewer.nextPage()),
    button("−", "Zoom out", () => pdfViewer.decreaseScale()),
    zoomLabel,
    button("+", "Zoom in", () => pdfViewer.increaseScale()),
    button("Fit width", "Fit the page to the window width", () => (pdfViewer.currentScaleValue = "page-width")),
    areaButton,
  );
  const frame = document.createElement("div");
  frame.className = "pdf-frame";
  const container = document.createElement("div");
  container.className = "pdf-scroll";
  container.tabIndex = 0;
  const viewerEl = document.createElement("div");
  viewerEl.className = "pdfViewer";
  container.append(viewerEl);
  frame.append(container);
  root.append(toolbar, frame);
  host.append(root);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const pdfViewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, textLayerMode: 1 });
  linkService.setViewer(pdfViewer);

  // ---------- page previews ----------

  let thumbs: Thumbs | null = null;
  let thumbsToken = 0;
  async function setThumbs(on: boolean): Promise<void> {
    const token = ++thumbsToken;
    remember(on);
    thumbsButton.classList.toggle("active", on);
    const fit = pdfViewer.currentScaleValue === "page-width";
    if (!on) {
      thumbs?.destroy();
      thumbs = null;
      frame.classList.remove("has-thumbs");
    } else if (!thumbs) {
      const pdf = pdfViewer.pdfDocument;
      if (!pdf) return;
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      if (token !== thumbsToken) return;
      thumbs = mountThumbs({
        count: pdf.numPages,
        ratio: first.height / first.width,
        pick: (n) => (pdfViewer.currentPageNumber = n),
        async draw(n, box, signal) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (THUMB_PX * Math.min(2, devicePixelRatio || 1)) / base.width });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          if (signal.aborted) return;
          await page.render({ canvas, viewport }).promise;
          page.cleanup();
          if (!signal.aborted) box.replaceChildren(canvas);
        },
      });
      frame.prepend(thumbs.el);
      frame.classList.add("has-thumbs");
      thumbs.current(pdfViewer.currentPageNumber);
    }
    if (fit) pdfViewer.currentScaleValue = "page-width"; // the window just got narrower or wider
  }

  // ---------- view <-> screen ----------

  /** Content box of a page's element in client coordinates (its transparent border excluded). */
  function pageBox(pageNumber: number): { left: number; top: number; width: number; height: number; el: HTMLElement } | null {
    const el = pdfViewer.getPageView(pageNumber - 1)?.div;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight, el };
  }

  const availableWidth = () => Math.max(1, container.clientWidth - SCROLLBAR_PADDING);

  let region: { page: number; rect: Rect } | null = null;

  function getView(): PageView {
    const cr = container.getBoundingClientRect();
    const midX = cr.left + container.clientWidth / 2;
    const midY = cr.top + container.clientHeight / 2;
    const current = pdfViewer.currentPageNumber;
    // The page under the middle of the window; the "current" page is only the most visible one.
    let page = current;
    for (const n of [current, current + 1, current - 1]) {
      const b = pageBox(n);
      if (b && midY >= b.top - 5 && midY <= b.top + b.height + 5) {
        page = n;
        break;
      }
    }
    const b = pageBox(page);
    const view: PageView = { v: 1, page };
    if (b && b.width > 0) {
      view.zoom = round(b.width / availableWidth());
      view.cx = round(clamp((midX - b.left) / b.width, 0, 1));
      view.cy = round(clamp((midY - b.top) / b.height, 0, 1));
    }
    if (region) {
      view.page = region.page;
      view.region = { x: round(region.rect.x), y: round(region.rect.y), w: round(region.rect.w), h: round(region.rect.h) };
    }
    return view;
  }

  /** Scrolls so the given point of a page is in the middle of the window (as far as the document edges allow). */
  function centreOn(pageNumber: number, cx: number, cy: number): void {
    const b = pageBox(pageNumber);
    if (!b) return;
    const cr = container.getBoundingClientRect();
    container.scrollLeft += b.left + cx * b.width - (cr.left + container.clientWidth / 2);
    container.scrollTop += b.top + cy * b.height - (cr.top + container.clientHeight / 2);
  }

  function setView(view: PageView): void {
    const total = pdfViewer.pagesCount;
    if (!total) return;
    const page = clamp(Math.round(view.page) || 1, 1, total);
    const pv = pdfViewer.getPageView(page - 1);
    const box = pageBox(page);
    if (!pv || !box) return;
    const baseWidth = box.width / pdfViewer.currentScale; // page width at scale 1
    let cx = view.cx ?? 0.5;
    let cy = view.cy ?? 0.5;
    let scale = view.zoom ? (view.zoom * availableWidth()) / baseWidth : null;

    const rect = view.region;
    if (rect && rect.w > 0 && rect.h > 0) {
      setRegion(page, rect);
      if (view.zoom === undefined && view.cx === undefined) {
        // A region without a position: fit it into the window with some air around it and centre it.
        const aspect = box.height / box.width; // page height / width
        const fitWidth = Math.min((container.clientWidth * 0.9) / rect.w, (container.clientHeight * 0.9) / (rect.h * aspect));
        scale = fitWidth / baseWidth;
        cx = rect.x + rect.w / 2;
        cy = rect.y + rect.h / 2;
      }
    } else {
      setRegion(null, null);
    }
    if (scale === null) scale = pdfViewer.currentScale;
    pdfViewer.currentScale = clamp(scale, MIN_SCALE, MAX_SCALE);
    centreOn(page, cx, cy);
  }

  // ---------- highlighted rectangle ----------

  const regionEl = document.createElement("div");
  regionEl.className = "pdf-region";
  const draftEl = document.createElement("div");
  draftEl.className = "pdf-region pdf-region-draft";

  /** pdf.js empties a page's element when it re-renders, so the overlay is re-attached after every render. */
  function attachRegion(): void {
    if (!region) return regionEl.remove();
    const el = pdfViewer.getPageView(region.page - 1)?.div;
    if (!el) return;
    Object.assign(regionEl.style, { left: `${region.rect.x * 100}%`, top: `${region.rect.y * 100}%`, width: `${region.rect.w * 100}%`, height: `${region.rect.h * 100}%` });
    if (regionEl.parentElement !== el) el.append(regionEl);
  }

  function setRegion(page: number | null, rect: Rect | null): void {
    region = page && rect ? { page, rect } : null;
    attachRegion();
  }

  eventBus.on("pagerendered", (e: { pageNumber: number }) => {
    if (region && e.pageNumber === region.page) attachRegion();
  });

  // ---------- selecting a rectangle ----------

  let selecting = false;
  function setSelecting(on: boolean): void {
    selecting = on;
    container.classList.toggle("selecting", on);
    areaButton.classList.toggle("active", on);
  }

  container.addEventListener("pointerdown", (event) => {
    if (!selecting || event.button !== 0) return;
    const pageEl = (event.target as HTMLElement).closest<HTMLElement>(".page");
    if (!pageEl) return;
    const pageNumber = Number(pageEl.dataset.pageNumber);
    const box = pageBox(pageNumber);
    if (!box) return;
    event.preventDefault();
    pageEl.setPointerCapture(event.pointerId);
    const at = (e: PointerEvent) => ({ x: clamp((e.clientX - box.left) / box.width, 0, 1), y: clamp((e.clientY - box.top) / box.height, 0, 1) });
    const start = at(event);
    const rectOf = (end: { x: number; y: number }): Rect => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) });
    pageEl.append(draftEl);
    const draw = (rect: Rect) => Object.assign(draftEl.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
    draw(rectOf(start));

    const move = (e: PointerEvent) => draw(rectOf(at(e)));
    const finish = (e: PointerEvent) => {
      pageEl.removeEventListener("pointermove", move);
      pageEl.removeEventListener("pointerup", finish);
      pageEl.removeEventListener("pointercancel", finish);
      draftEl.remove();
      const rect = rectOf(at(e));
      if (e.type === "pointerup" && rect.w >= MIN_REGION && rect.h >= MIN_REGION) {
        setRegion(pageNumber, rect);
        scheduleView(0);
      }
      setSelecting(false);
    };
    pageEl.addEventListener("pointermove", move);
    pageEl.addEventListener("pointerup", finish);
    pageEl.addEventListener("pointercancel", finish);
  });

  // ---------- reporting the view ----------

  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = "";
  function scheduleView(delay = VIEW_DEBOUNCE_MS): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!pdfViewer.pagesCount) return;
      const view = getView();
      const key = JSON.stringify(view);
      if (key === lastSent) return;
      lastSent = key;
      options.onView(view);
    }, delay);
  }

  let touched = false; // once the reader scrolls by hand, a late layout change must not yank them back to the link's position
  for (const type of ["wheel", "pointerdown", "keydown", "touchstart"] as const) container.addEventListener(type, () => (touched = true), { passive: true });
  container.addEventListener("scroll", () => scheduleView(), { passive: true });
  eventBus.on("scalechanging", (e: { scale: number }) => {
    zoomLabel.textContent = `${Math.round(e.scale * 100)}%`;
    scheduleView();
  });
  eventBus.on("pagechanging", (e: { pageNumber: number }) => {
    pageInput.value = String(e.pageNumber);
    thumbs?.current(e.pageNumber);
    scheduleView();
  });
  pageInput.addEventListener("change", () => {
    pdfViewer.currentPageNumber = clamp(Math.round(Number(pageInput.value)) || 1, 1, pdfViewer.pagesCount || 1);
  });
  const onResize = () => scheduleView();
  addEventListener("resize", onResize);

  // ---------- open the document ----------

  const task = pdfjsLib.getDocument({
    url: options.url,
    withCredentials: true,
    wasmUrl: "/pdfjs/wasm/",
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    iccUrl: "/pdfjs/iccs/",
  });
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const entered = prompt(reason === 2 ? "Wrong password. Try again:" : "This PDF is protected. Password:");
    if (entered === null) options.onError(new Error("A password is required to open this PDF."));
    else update(entered);
  };

  let initial: PageView | null = options.view ?? null;
  const applyInitial = () => {
    if (initial) setView(initial);
    else pdfViewer.currentScaleValue = "page-width";
  };
  eventBus.on("pagesinit", () => {
    pageCount.textContent = `/ ${pdfViewer.pagesCount}`;
    pageInput.max = String(pdfViewer.pagesCount);
    pageInput.value = String(pdfViewer.currentPageNumber);
    if (remembered()) void setThumbs(true);
    applyInitial();
    scheduleView();
  });
  // Page sizes finish arriving after the first render and shift the layout: place the link's view again, unless the reader already moved.
  eventBus.on("pagesloaded", () => {
    if (!touched && initial) setView(initial);
    scheduleView();
  });

  task.promise
    .then((doc: Parameters<typeof pdfViewer.setDocument>[0]) => {
      pdfViewer.setDocument(doc);
      linkService.setDocument(doc, null);
    })
    .catch((err: unknown) => options.onError(err instanceof Error ? err : new Error(String(err))));

  /**
   * A printout is made of pictures of the pages (or of one rectangle of one page), because that
   * looks the same in every browser and needs no PDF plug-in; the original file stays one click
   * away in the print dialog for anyone who wants the exact PDF.
   */
  function printJob(): PrintJob {
    const pdf = pdfViewer.pdfDocument;
    const total = pdfViewer.pagesCount;
    const view = getView();
    const area = region;
    return {
      choices: [
        { id: "all", label: t("print.allPages", { n: total }) },
        { id: "here", label: t("print.thisPage", { n: view.page }) },
        { id: "range", label: t("print.pages"), range: { max: total, from: view.page } },
        ...(area ? [{ id: "area", label: t("print.area", { n: area.page }) }] : []),
      ],
      initial: area ? "area" : "all",
      async render(choice, range, ctx) {
        if (!pdf) throw new Error("not loaded");
        const [first, last] = choice === "all" ? [1, total] : choice === "range" && range ? range : choice === "area" && area ? [area.page, area.page] : [view.page, view.page];
        for (let n = first; n <= last; n++) {
          if (ctx.signal.aborted) return;
          ctx.progress(n - first + 1, last - first + 1);
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const crop = choice === "area" && area ? area.rect : null;
          const scale = Math.min(MAX_SCALE, PRINT_PAGE_PX / (base.width * (crop?.w ?? 1)), PRINT_MAX_SIDE / (base.width * (crop?.w ?? 1)), PRINT_MAX_SIDE / (base.height * (crop?.h ?? 1)));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width * (crop?.w ?? 1)));
          canvas.height = Math.max(1, Math.ceil(viewport.height * (crop?.h ?? 1)));
          await page.render({ canvas, viewport, ...(crop ? { transform: [1, 0, 0, 1, -crop.x * viewport.width, -crop.y * viewport.height] } : {}) }).promise;
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
          page.cleanup();
          if (!blob) throw new Error("could not draw page " + n);
          const url = URL.createObjectURL(blob);
          ctx.onCleanup(() => URL.revokeObjectURL(url));
          addPageImage(ctx.root, url);
        }
      },
    };
  }

  return {
    getView,
    printJob,
    setView: (view) => {
      initial = view;
      touched = false;
      setView(view);
    },
    destroy() {
      clearTimeout(timer);
      thumbs?.destroy();
      removeEventListener("resize", onResize);
      void task.destroy();
      pdfViewer.cleanup();
      root.remove();
    },
  };
}
