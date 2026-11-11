import * as pdfjsLib from "pdfjs-dist/build/pdf.min.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { t } from "../i18n";
import { el, openModal } from "../ui";
import { addPageImage, type PrintJob } from "../print";
import type { Crop, Display } from "../display";
import { clipToCrop, cropFor, intoCrop, outOfCrop, rectIntoCrop, rectOutOfCrop } from "./crop";
import { createCropEditor } from "./cropEditor";
import { bookIdOf, createScanText, type ScanText } from "./scanLayer";
import { readerMode, setReaderMode } from "../readerMode";
import { pdfDocumentOptions } from "./pdfAssets";
import { mountThumbs, type Thumbs } from "./thumbs";
import { fileOf, offsetFor, printedOf } from "./printed";
import { rectToPage, rectToScreen, toPage, toScreen } from "./rotation";
import type { PageView, ReaderHandle, Rect } from "./types";
import type { Loading } from "./loading";

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
  /** A short name of the place being read, as a bookmark would carry it: the printed page when the book has an offset. */
  getLabel(): string;
  setView(view: PageView): void;
  printJob(): PrintJob;
}

export interface PdfOptions {
  url: string;
  view?: PageView | null;
  /** Called when what is on screen changes, at most every 250 ms and never twice with the same view. */
  onView(view: PageView): void;
  /** How the reader likes to see this book; changes are reported through `onDisplay` so they can be remembered. */
  display?: Display;
  onDisplay?(display: Display): void;
  onError(error: Error): void;
  /** Tells how much of the file has come; the reader takes it away when the first page is laid out. */
  loading?: Loading;
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
  pageInput.setAttribute("aria-label", t("pdf.page"));
  const pageCount = document.createElement("span");
  const printedInput = document.createElement("input");
  printedInput.type = "number";
  printedInput.className = "pdf-page-input pdf-printed-input";
  printedInput.placeholder = "—";
  printedInput.hidden = true;
  printedInput.setAttribute("aria-label", t("pdf.printed"));
  printedInput.title = t("pdf.printed");
  const printedButton = button("№", t("pdf.printedTitle"), () => openPrintedDialog());
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "pdf-zoom";
  const thumbsButton = button("▥", t("pages.toggle"), () => void setThumbs(!thumbs));
  thumbsButton.setAttribute("aria-label", t("pages.toggle"));
  const areaButton = button(`▭ ${t("pdf.area")}`, t("pdf.areaTitle"), () => setSelecting(!selecting));
  const turnButton = button("⟳", t("pdf.turnTitle"), () => turnPages());
  turnButton.setAttribute("aria-label", t("pdf.turn"));
  const focusButton = button("⛶", t("pdf.focusTitle"), () => setFocus(!readerMode()));
  focusButton.setAttribute("aria-label", t("pdf.focus"));
  focusButton.setAttribute("aria-pressed", "false");
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  let scaleBeforeCrop: string | null = null;
  const cropEditor = createCropEditor({
    page: () => getView().page,
    pageElement: (n) => pdfViewer.getPageView(n - 1)?.div ?? null,
    pageBox: (n) => pageBox(n),
    turn: () => turn,
    committed: () => committed,
    show: (next) => showCrop(next),
    holdPlace: (change) => holdPlace(change),
    keep: (next) => {
      committed = next;
      reportDisplay();
    },
    fitPage: () => {
      scaleBeforeCrop = String(pdfViewer.currentScaleValue);
      const page = getView().page; // the page under the middle of the window, which is the one being read
      pdfViewer.currentScaleValue = "page-fit";
      pdfViewer.scrollPageIntoView({ pageNumber: page }); // all of the page, frame handles included, is in view
    },
    onMode: (on) => {
      if (on) setSelecting(false);
      else if (scaleBeforeCrop !== null) pdfViewer.currentScaleValue = scaleBeforeCrop; // back to the zoom the reader had
      if (!on) scaleBeforeCrop = null;
      areaButton.disabled = on; // an area is drawn on the pages as they are kept
      turnButton.disabled = on;
    },
  });
  toolbar.append(
    thumbsButton,
    button("‹", t("pdf.prev"), () => pdfViewer.previousPage()),
    pageInput,
    pageCount,
    button("›", t("pdf.next"), () => pdfViewer.nextPage()),
    printedButton,
    printedInput,
    button("−", t("pdf.zoomOut"), () => pdfViewer.decreaseScale()),
    zoomLabel,
    button("+", t("pdf.zoomIn"), () => pdfViewer.increaseScale()),
    button(t("pdf.fitWidth"), t("pdf.fitWidthTitle"), () => (pdfViewer.currentScaleValue = "page-width")),
    button(t("pdf.fitPage"), t("pdf.fitPageTitle"), () => (pdfViewer.currentScaleValue = "page-fit")),
    turnButton,
    cropEditor.button,
    areaButton,
    focusButton,
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
  root.append(toolbar, cropEditor.tools, frame);
  host.append(root);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const pdfViewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, textLayerMode: 1 });
  linkService.setViewer(pdfViewer);

  // ---------- turning the pages ----------

  /** Clockwise, in degrees, for every page of the book. Positions, areas and links stay in the page as the file has it. */
  let turn: number = options.display?.rotation ?? 0;
  /** Pages of the file before the book's printed page 1 (see printed.ts); 0 when the file's numbers are the book's. */
  let offset = options.display?.pageOffset ?? 0;

  /** Which part of each page is shown. The pages are cut when they are loaded, see `cutPage`. */
  let committed: Crop | undefined = options.display?.crop; // what is kept for the book
  let crop: Crop | undefined = committed; // what the pages are cut like on screen right now (the editor shows them whole, or in preview)
  const reportDisplay = () => options.onDisplay?.({ ...(turn ? { rotation: turn as 90 | 180 | 270 } : {}), ...(committed ? { crop: committed } : {}), ...(offset ? { pageOffset: offset } : {}) });

  // ---------- printed page numbers ----------

  /** Shows the file's page number in the page box and the book's printed one beside it. */
  function showNumbers(page: number): void {
    pageInput.value = String(page);
    printedInput.hidden = offset === 0;
    printedInput.value = offset ? String(printedOf(page, offset) ?? "") : "";
    printedButton.classList.toggle("active", offset !== 0);
  }

  function getLabel(): string {
    const page = getView().page;
    const printed = offset ? printedOf(page, offset) : page;
    return printed === null ? t("bookmark.filePage", { n: page }) : t("bookmark.page", { n: printed });
  }

  function setOffset(next: number): void {
    offset = next;
    showNumbers(pdfViewer.currentPageNumber);
    reportDisplay();
  }

  /** Asks which printed number the page being read has, which fixes the offset for the whole book. */
  function openPrintedDialog(): void {
    const filePage = getView().page;
    const modal = openModal(t("pdf.printedHeading"));
    const printed = el("input", { type: "number", min: "1", class: "pdf-page-input pdf-printed-input", value: String(printedOf(filePage, offset) ?? 1) });
    printed.setAttribute("aria-label", t("pdf.printed"));
    const apply = el("button", { type: "button", class: "btn primary", textContent: t("pdf.printedApply") });
    const reset = el("button", { type: "button", class: "btn", textContent: t("pdf.printedReset"), hidden: offset === 0 });
    const check = () => {
      const n = Number(printed.value);
      apply.disabled = !Number.isInteger(n) || n < 1 || Math.abs(offsetFor(filePage, n)) > 9999;
    };
    printed.addEventListener("input", check);
    printed.addEventListener("keydown", (e) => e.key === "Enter" && !apply.disabled && apply.click());
    apply.addEventListener("click", () => {
      setOffset(offsetFor(filePage, Number(printed.value)));
      modal.close();
    });
    reset.addEventListener("click", () => {
      setOffset(0);
      modal.close();
    });
    modal.body.append(
      el("p", { textContent: t("pdf.printedText") }),
      el("label", { class: "printed-row" }, el("span", { textContent: t("pdf.printedIs", { n: filePage }) }), printed),
      el("div", { class: "printed-actions" }, apply, reset),
    );
    check();
    printed.focus();
    printed.select();
  }

  // Everything outside this module's drawing code keeps to the whole page as the file has it. These four turn
  // that into what is on screen (cut, then turned) and back, for page `n`; a rectangle outside the cut has no
  // shape on screen (null).
  const cutOf = (n: number): Rect | null => cropFor(crop, n);
  const pointToShown = (n: number, p: { x: number; y: number }) => {
    const q = toScreen(intoCrop(p, cutOf(n)), turn);
    // a spot in a margin that is cut away goes to the nearest edge of what is left, a little inside it, so it is
    // clearly on this page and not on the border between two
    return { x: clamp(q.x, 0.01, 0.99), y: clamp(q.y, 0.01, 0.99) };
  };
  const pointFromShown = (n: number, p: { x: number; y: number }) => outOfCrop(toPage(p, turn), cutOf(n));
  const rectToShown = (n: number, r: Rect): Rect | null => {
    const inside = clipToCrop(r, cutOf(n));
    return inside && rectToScreen(rectIntoCrop(inside, cutOf(n)), turn);
  };
  const rectFromShown = (n: number, r: Rect): Rect => rectOutOfCrop(rectToPage(r, turn), cutOf(n));

  /**
   * Makes the viewer see only the cut of a page: pdf.js builds every page's size, drawing and text layer from
   * the page's visible box, so giving the page a smaller box is all it takes, and the file is not touched.
   * The original box is kept to cut from, so cutting again never compounds.
   */
  const wholeBox = new WeakMap<object, number[]>();
  function cutPage(page: pdfjsLib.PDFPageProxy, n: number): void {
    const info = (page as unknown as { _pageInfo: { view: number[] } })._pageInfo;
    if (!wholeBox.has(page)) wholeBox.set(page, [...info.view]);
    info.view = wholeBox.get(page)!;
    const c = cutOf(n);
    if (!c) return;
    const whole = page.getViewport({ scale: 1 });
    const a = whole.convertToPdfPoint(c.x * whole.width, c.y * whole.height);
    const b = whole.convertToPdfPoint((c.x + c.w) * whole.width, (c.y + c.h) * whole.height);
    info.view = [Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.max(a[0]!, b[0]!), Math.max(a[1]!, b[1]!)];
  }

  // ---------- the words of a recognized scan ----------

  // laid over the picture in no colour, so that they can be selected and copied; a book that was never recognized asks for nothing more than the list of its pages
  const bookId = bookIdOf(options.url);
  const scanText: ScanText | null = bookId
    ? createScanText({
        bookId,
        pageEl: (n) => pdfViewer.getPageView(n - 1)?.div ?? null,
        cutOf,
        aspectOf: (n) => {
          const page = pdfViewer.getPageView(n - 1)?.pdfPage;
          if (!page) return null;
          const view = page.getViewport({ scale: 1 }); // the page as the file has it, cut as it is cut
          return view.width / view.height;
        },
        turn: () => turn,
        pageCount: () => pdfViewer.pagesCount,
      })
    : null;

  /** Runs a change that moves or resizes the reading area (a row of controls appearing), keeping the spot in the middle of the window. */
  function holdPlace(change: () => void): void {
    if (!pdfViewer.pagesCount) return change();
    const view = getView();
    change();
    refit();
    const shownAt = pointToShown(view.page, { x: view.cx ?? 0.5, y: view.cy ?? 0.5 });
    centreOn(view.page, shownAt.x, shownAt.y);
  }

  /**
   * Shows the pages with another crop without reopening the book: the pages the viewer already has are cut
   * again and given their new size, the fitted scale is fitted again, and the spot that was in the middle of
   * the window stays there.
   */
  function showCrop(next: Crop | undefined): void {
    if (!pdfViewer.pagesCount) return;
    const view = getView(); // read with the old crop, in the whole page
    crop = next;
    for (let i = 0; i < pdfViewer.pagesCount; i++) {
      const pageView = pdfViewer.getPageView(i);
      const page = pageView?.pdfPage;
      if (!pageView || !page) continue; // a page not loaded yet is cut when it is
      cutPage(page, i + 1);
      pageView.setPdfPage(page);
      // the viewer sizes a page's box again only when the page was turned, so a changed box is given its size here
      pdfjsLib.setLayerDimensions(pageView.div, pageView.viewport, true, false);
    }
    refit();
    pdfViewer.update();
    const shownAt = pointToShown(view.page, { x: view.cx ?? 0.5, y: view.cy ?? 0.5 });
    centreOn(view.page, shownAt.x, shownAt.y);
    attachRegion();
    scanText?.refresh();
    if (thumbs) void setThumbs(true, true);
    cropEditor.place();
    scheduleView(0);
  }

  // ---------- page previews ----------

  let thumbs: Thumbs | null = null;
  let thumbsToken = 0;
  async function setThumbs(on: boolean, rebuild = false): Promise<void> {
    const token = ++thumbsToken;
    if (!rebuild) remember(on);
    thumbsButton.classList.toggle("active", on);
    if (!on || rebuild) {
      thumbs?.destroy();
      thumbs = null;
      frame.classList.remove("has-thumbs");
    }
    if (on && !thumbs) {
      const pdf = pdfViewer.pdfDocument;
      if (!pdf) return;
      const firstPage = await pdf.getPage(1);
      const first = firstPage.getViewport({ scale: 1, rotation: (firstPage.rotate + turn) % 360 });
      if (token !== thumbsToken) return;
      thumbs = mountThumbs({
        count: pdf.numPages,
        ratio: first.height / first.width,
        pick: (n) => (pdfViewer.currentPageNumber = n),
        async draw(n, box, signal) {
          const page = await pdf.getPage(n);
          const rotation = (page.rotate + turn) % 360;
          const base = page.getViewport({ scale: 1, rotation });
          const viewport = page.getViewport({ scale: (THUMB_PX * Math.min(2, devicePixelRatio || 1)) / base.width, rotation });
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
  }

  // ---------- reading mode and fitting ----------

  /** A fitted page follows the window: panels coming and going, a phone turned around, a window dragged. */
  const refit = () => {
    const mode = pdfViewer.currentScaleValue;
    if (pdfViewer.pagesCount && (mode === "page-width" || mode === "page-fit")) pdfViewer.currentScaleValue = mode;
  };
  /** Turns every page a quarter clockwise, keeping the spot that is in the middle of the window, and remembers it for this book. */
  function turnPages(): void {
    const view = getView(); // in the page as the file has it, so it does not matter how the book was turned before
    turn = (turn + 90) % 360;
    pdfViewer.pagesRotation = turn; // a fitted page is fitted again by the viewer itself
    attachRegion();
    scanText?.refresh();
    if (thumbs) void setThumbs(true, true);
    const shownAt = pointToShown(view.page, { x: view.cx ?? 0.5, y: view.cy ?? 0.5 });
    centreOn(view.page, shownAt.x, shownAt.y);
    reportDisplay();
    scheduleView(0);
  }
  const resizes = new ResizeObserver(refit);
  resizes.observe(container);

  function setFocus(on: boolean): void {
    setReaderMode(on);
    focusButton.classList.toggle("active", on);
    focusButton.setAttribute("aria-pressed", String(on));
    focusButton.title = on ? t("pdf.focusExit") : t("pdf.focusTitle");
    if (on) container.focus({ preventScroll: true });
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (cropEditor.active()) cropEditor.cancel(); // first Esc leaves cropping, the next one reading mode
    else if (readerMode()) setFocus(false);
  };
  addEventListener("keydown", onKey);

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
      const at = pointFromShown(page, { x: clamp((midX - b.left) / b.width, 0, 1), y: clamp((midY - b.top) / b.height, 0, 1) });
      view.cx = round(at.x);
      view.cy = round(at.y);
    }
    // The rectangle belongs to the view only while its page is the one on screen: after the reader has gone on to
    // another page, a link or bookmark made there must lead there, not back to the page the rectangle was drawn on.
    if (region && region.page === page) {
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
    let cx = view.cx ?? 0.5; // where the view looks, in the page as the file has it
    let cy = view.cy ?? 0.5;
    let scale = view.zoom ? (view.zoom * availableWidth()) / baseWidth : null;

    const rect = view.region;
    if (rect && rect.w > 0 && rect.h > 0) {
      setRegion(page, rect);
      if (view.zoom === undefined && view.cx === undefined) {
        // A region without a position: fit it into the window with some air around it and centre it.
        const aspect = box.height / box.width; // page height / width, as shown
        const shown = rectToShown(page, rect); // null when the area lies outside the cut: then the view stays where it is
        if (shown) {
          const fitWidth = Math.min((container.clientWidth * 0.9) / shown.w, (container.clientHeight * 0.9) / (shown.h * aspect));
          scale = fitWidth / baseWidth;
          cx = rect.x + rect.w / 2;
          cy = rect.y + rect.h / 2;
        }
      }
    } else {
      setRegion(null, null);
    }
    if (scale === null) scale = pdfViewer.currentScale;
    pdfViewer.currentScale = clamp(scale, MIN_SCALE, MAX_SCALE);
    const shownAt = pointToShown(page, { x: cx, y: cy });
    centreOn(page, shownAt.x, shownAt.y);
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
    const r = rectToShown(region.page, region.rect);
    if (!r) return regionEl.remove(); // the area lies in a margin that is cut away
    Object.assign(regionEl.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
    if (regionEl.parentElement !== el) el.append(regionEl);
  }

  function setRegion(page: number | null, rect: Rect | null): void {
    region = page && rect ? { page, rect } : null;
    attachRegion();
  }

  eventBus.on("pagerendered", (e: { pageNumber: number }) => {
    scanText?.show(e.pageNumber); // the viewer empties a page's element when it draws it again
    if (region && e.pageNumber === region.page) attachRegion();
    if (cropEditor.active()) cropEditor.place();
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
      const rect = rectOf(at(e)); // as shown
      if (e.type === "pointerup" && rect.w >= MIN_REGION && rect.h >= MIN_REGION) {
        setRegion(pageNumber, rectFromShown(pageNumber, rect));
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
  for (const type of ["wheel", "pointerdown", "keydown", "touchstart"] as const) for (const where of [container, toolbar]) where.addEventListener(type, () => (touched = true), { passive: true }); // the page box and the buttons count as moving too
  container.addEventListener("scroll", () => scheduleView(), { passive: true });
  eventBus.on("scalechanging", (e: { scale: number }) => {
    zoomLabel.textContent = `${Math.round(e.scale * 100)}%`;
    scheduleView();
  });
  eventBus.on("pagechanging", (e: { pageNumber: number }) => {
    showNumbers(e.pageNumber);
    thumbs?.current(e.pageNumber);
    if (cropEditor.active()) cropEditor.place();
    scheduleView();
  });
  printedInput.addEventListener("change", () => {
    const n = Math.round(Number(printedInput.value));
    if (!offset || !n) return showNumbers(pdfViewer.currentPageNumber); // an empty or nonsense entry puts back what is there
    pdfViewer.currentPageNumber = clamp(fileOf(n, offset), 1, pdfViewer.pagesCount || 1);
  });
  pageInput.addEventListener("change", () => {
    pdfViewer.currentPageNumber = clamp(Math.round(Number(pageInput.value)) || 1, 1, pdfViewer.pagesCount || 1);
  });
  const onResize = () => scheduleView();
  addEventListener("resize", onResize);

  // ---------- open the document ----------

  const task = pdfjsLib.getDocument(pdfDocumentOptions(options.url));
  task.onProgress = ({ loaded, total }: { loaded: number; total?: number }) => options.loading?.update({ loaded, total: total && total >= loaded ? total : null });
  task.onPassword = (update: (password: string) => void, reason: number) => {
    options.loading?.done(); // the question is asked over the page
    const entered = prompt(reason === 2 ? t("pdf.passwordAgain") : t("pdf.password"));
    if (entered === null) options.onError(new Error(t("pdf.passwordNeeded")));
    else update(entered);
  };

  let initial: PageView | null = options.view ?? null;
  const applyInitial = () => {
    if (initial) setView(initial);
    else pdfViewer.currentScaleValue = "page-width";
  };
  eventBus.on("pagesinit", () => {
    options.loading?.done();
    pageCount.textContent = `/ ${pdfViewer.pagesCount}`;
    pageInput.max = String(pdfViewer.pagesCount);
    showNumbers(pdfViewer.currentPageNumber);
    if (turn) pdfViewer.pagesRotation = turn;
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
      if (doc) {
        // Every page the viewer, the previews and the printout ask for comes cut.
        const getPage = doc.getPage.bind(doc);
        doc.getPage = async (n: number) => {
          const page = await getPage(n);
          cutPage(page, n);
          return page;
        };
      }
      pdfViewer.setDocument(doc);
      linkService.setDocument(doc, null);
    })
    .catch((err: unknown) => {
      options.loading?.done();
      options.onError(err instanceof Error ? err : new Error(String(err)));
    });

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
          const rotation = (page.rotate + turn) % 360; // the printout is turned the way the reader sees the book
          const base = page.getViewport({ scale: 1, rotation });
          const part = choice === "area" && area ? rectToShown(area.page, area.rect) : null;
          const scale = Math.min(MAX_SCALE, PRINT_PAGE_PX / (base.width * (part?.w ?? 1)), PRINT_MAX_SIDE / (base.width * (part?.w ?? 1)), PRINT_MAX_SIDE / (base.height * (part?.h ?? 1)));
          const viewport = page.getViewport({ scale, rotation });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width * (part?.w ?? 1)));
          canvas.height = Math.max(1, Math.ceil(viewport.height * (part?.h ?? 1)));
          await page.render({ canvas, viewport, ...(part ? { transform: [1, 0, 0, 1, -part.x * viewport.width, -part.y * viewport.height] } : {}) }).promise;
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
    getLabel,
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
      removeEventListener("keydown", onKey);
      cropEditor.destroy();
      scanText?.destroy();
      resizes.disconnect();
      setFocus(false);
      void task.destroy();
      pdfViewer.cleanup();
      root.remove();
    },
  };
}
