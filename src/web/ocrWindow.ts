import { t, type Key } from "./i18n";
import { defaultLanes, OCR_LANGS, ocrSupported, OcrBookError, Readers, recognizeBook, type OcrLang } from "./ocrEngine";
import { filterRows, isUnread, OCR_SHOWS, OCR_SORTS, sortRows, type OcrListRow, type OcrShow, type OcrSort } from "./ocrList";
import { splitEta, type OcrProgress } from "./ocrRun";
import { openProof } from "./proofWindow";
import { api, el, openModal, store } from "./ui";

interface Row extends OcrListRow {
  /** Pages a person has corrected by hand. */
  edited: number;
  /** Pictures cut from the scan. */
  images: number;
  lang: string | null;
}

interface Listing {
  enabled: boolean;
  books: Row[];
  recognizedBooks: number;
  recognizedPages: number;
}

const LANG_KEY = "tapalog.ocrLang";
const SORT_KEY = "tapalog.ocrSort";

/** "2 h 5 min", "14 min", "40 s" in the reader's language. */
function etaText(seconds: number): string {
  const { hours, minutes, seconds: s } = splitEta(seconds);
  if (hours) return minutes ? t("ocr.eta.hmin", { h: hours, m: minutes }) : t("ocr.eta.h", { h: hours });
  return minutes ? t("ocr.eta.min", { n: minutes }) : t("ocr.eta.s", { n: s });
}

/**
 * The window for reading scanned books: the PDFs that have no text of their own, how far each has been read, and
 * a button that reads the chosen ones in this browser, one after another, until the end or a stop. Closing the
 * window stops the reading (the text read so far stays on the server). `focus` adds a book that is not in the list
 * (a PDF with text, opened from its card) and ticks it.
 */
export async function openOcr(opts: { focus?: { id: string; title: string; path: string }; changed?: () => void } = {}): Promise<void> {
  const abort = { current: null as AbortController | null };
  const modal = openModal(t("ocr.title"), () => abort.current?.abort());
  modal.body.append(el("p", { class: "muted", textContent: t("card.loading") }));
  let list: Listing;
  try {
    list = await api<Listing>("/api/admin/ocr");
  } catch {
    modal.body.replaceChildren(el("p", { class: "muted", textContent: t("card.failed") }));
    return;
  }

  const rows = new Map<string, Row>();
  const checked = new Set<string>();
  const locked = new Set<string>(); // could not be opened in this window
  const failedPages = new Map<string, number>();
  const statusOf = new Map<string, HTMLElement>();
  const boxOf = new Map<string, HTMLInputElement>();
  let running = false;
  let shownCount = 0;

  const savedLang = store.get(LANG_KEY);
  const lang = el("select", { class: "ocr-lang" }, ...OCR_LANGS.map((l) => el("option", { value: l, textContent: t(`ocr.lang.${l}` as Key) })));
  lang.value = OCR_LANGS.includes(savedLang as OcrLang) ? savedLang! : "rus";
  lang.addEventListener("change", () => store.set(LANG_KEY, lang.value));

  const savedSort = store.get(SORT_KEY);
  const sort = el("select", { class: "ocr-sort", title: t("ocr.sort") }, ...OCR_SORTS.map((k) => el("option", { value: k, textContent: t(`ocr.sort.${k}` as Key) })));
  sort.value = OCR_SORTS.includes(savedSort as OcrSort) ? savedSort! : "path";
  const show = el("select", { class: "ocr-show", title: t("ocr.show") }, ...OCR_SHOWS.map((k) => el("option", { value: k, textContent: t(`ocr.show.${k}` as Key) })));
  const query = el("input", { type: "search", class: "ocr-query", placeholder: t("ocr.query"), autocomplete: "off" });
  const count = el("p", { class: "muted small ocr-count" });
  const tools = el("div", { class: "ocr-tools" }, query, show, sort);
  const visible = (): Row[] => sortRows(filterRows([...rows.values()], query.value, show.value as OcrShow), sort.value as OcrSort);

  const listEl = el("div", { class: "ocr-list" });
  const start = el("button", { type: "button", class: "btn primary", textContent: t("ocr.start") });
  const stop = el("button", { type: "button", class: "btn", textContent: t("ocr.stop"), hidden: true });
  const selectUnread = el("button", { type: "button", class: "btn", textContent: t("ocr.selectUnread") });
  const bar = el("progress", { class: "ocr-bar", max: 1, value: 0, hidden: true });
  const progressLine = el("p", { class: "muted small ocr-progress", hidden: true });
  const message = el("p", { class: "small ocr-message", hidden: true });
  const kept = el("p", { class: "muted small ocr-kept" });
  const say = (text: string, bad = false) => {
    message.hidden = !text;
    message.textContent = text;
    message.className = bad ? "project-missing ocr-message" : "small ocr-message";
  };

  const statusText = (row: Row): string => {
    if (locked.has(row.id)) return t("ocr.row.locked");
    const failed = failedPages.get(row.id) ?? 0;
    const base = row.pages === null || row.done === 0 ? t("ocr.row.new") : row.done >= row.pages ? t("ocr.row.done", { pages: row.pages }) : t("ocr.row.partial", { done: row.done, pages: row.pages });
    return failed ? `${base} · ${t("ocr.row.failed", { n: failed })}` : base;
  };

  function take(next: Listing): void {
    list = next;
    rows.clear();
    for (const r of next.books) rows.set(r.id, r);
    if (opts.focus && !rows.has(opts.focus.id)) rows.set(opts.focus.id, { id: opts.focus.id, title: opts.focus.title, path: opts.focus.path, size: 0, pages: null, done: 0, edited: 0, images: 0, lang: null });
    for (const id of [...checked]) if (!rows.has(id)) checked.delete(id);
  }

  function draw(): void {
    statusOf.clear();
    boxOf.clear();
    const supported = ocrSupported();
    const shown = visible();
    tools.hidden = count.hidden = !rows.size;
    shownCount = shown.length;
    if (!rows.size) {
      listEl.replaceChildren(el("p", { class: "muted", textContent: list.enabled ? t("ocr.empty") : t("ocr.needIndex") }));
    } else if (!shown.length) {
      listEl.replaceChildren(el("p", { class: "muted", textContent: t("ocr.noMatch") }));
    } else {
      listEl.replaceChildren(
        ...shown.map((row) => {
          const box = el("input", { type: "checkbox", checked: checked.has(row.id), disabled: running });
          box.addEventListener("change", () => {
            if (box.checked) checked.add(row.id);
            else checked.delete(row.id);
            update();
          });
          const status = el("span", { class: "muted small ocr-status", textContent: statusText(row) });
          statusOf.set(row.id, status);
          boxOf.set(row.id, box);
          const forget = el("button", { type: "button", class: "btn small ocr-forget", textContent: t("ocr.forget"), hidden: row.done === 0, disabled: running });
          forget.addEventListener("click", async () => {
            const ask = row.edited && row.images ? t("ocr.forgetBothAsk", { n: row.edited, m: row.images }) : row.images ? t("ocr.forgetFiguresAsk", { m: row.images }) : row.edited ? t("ocr.forgetEditedAsk", { n: row.edited }) : t("ocr.forgetAsk");
            if (!confirm(ask)) return;
            await api(`/api/admin/ocr/${encodeURIComponent(row.id)}`, undefined, "DELETE");
            failedPages.delete(row.id);
            await refresh();
            opts.changed?.();
          });
          const proof = el("button", { type: "button", class: "btn small ocr-proof", textContent: t("ocr.proof"), hidden: row.done === 0 });
          proof.addEventListener("click", () => void openProof({ id: row.id, title: row.title }, { changed: () => void refresh().then(() => opts.changed?.()) }));
          return el("label", { class: "ocr-row" }, box, el("span", { class: "ocr-what" }, el("span", { class: "ocr-title", textContent: row.title }), el("span", { class: "muted small ocr-path", textContent: row.path }), status), proof, forget);
        }),
      );
    }
    kept.textContent = list.recognizedPages ? t("ocr.kept", { pages: list.recognizedPages, books: list.recognizedBooks }) : "";
    kept.hidden = !list.recognizedPages;
    lang.disabled = running;
    selectUnread.disabled = running || !supported;
    update();
  }

  function update(): void {
    count.textContent = t("ocr.count", { shown: shownCount, total: rows.size, ticked: checked.size });
    start.disabled = running || !ocrSupported() || checked.size === 0;
    start.hidden = running;
    stop.hidden = !running;
  }

  async function refresh(): Promise<void> {
    take(await api<Listing>("/api/admin/ocr"));
    draw();
  }

  selectUnread.addEventListener("click", () => {
    for (const row of visible()) if (isUnread(row)) checked.add(row.id); // only the books on view: a filter picks a folder
    draw();
  });
  query.addEventListener("input", draw);
  show.addEventListener("change", draw);
  sort.addEventListener("change", () => {
    store.set(SORT_KEY, sort.value);
    draw();
  });
  stop.addEventListener("click", () => {
    abort.current?.abort();
    stop.disabled = true;
  });

  start.addEventListener("click", async () => {
    const queue = sortRows([...rows.values()].filter((r) => checked.has(r.id)), sort.value as OcrSort); // in the order the list shows them
    if (!queue.length) return;
    const controller = new AbortController();
    abort.current = controller;
    running = true;
    stop.disabled = false;
    say("");
    draw();
    bar.hidden = progressLine.hidden = false;
    let read = 0;
    let serverError = false;
    const readers = new Readers(lang.value as OcrLang); // made for the first book, kept for the next ones, ended with the run
    for (const [index, row] of queue.entries()) {
      if (controller.signal.aborted) break;
      const showProgress = (p: OcrProgress) => {
        row.done = p.done;
        row.pages = p.pages;
        bar.value = p.pages ? p.done / p.pages : 0;
        const where = t("ocr.progress", { book: index + 1, books: queue.length, done: p.done, pages: p.pages });
        progressLine.textContent = p.etaSeconds === null ? where : `${where} · ${t("ocr.eta", { time: etaText(p.etaSeconds) })}`;
        const status = statusOf.get(row.id); // looked up each time: the list may have been drawn again by a filter
        if (status) status.textContent = t("ocr.row.running", { done: p.done, pages: p.pages });
      };
      const before = row.done;
      bar.value = 0; // this book's own progress: the last one's is not shown while the engine loads
      try {
        const outcome = await recognizeBook({
          id: row.id,
          lang: readers.lang,
          readers,
          signal: controller.signal,
          lanes: defaultLanes(),
          onProgress: showProgress,
          onState: (s) => (progressLine.textContent = s === "loading" ? t("ocr.loading") : progressLine.textContent),
        });
        read += outcome.done - before;
        if (outcome.failed.length) failedPages.set(row.id, outcome.failed.length);
        row.done = outcome.done;
        if (outcome.error) {
          serverError = true;
          break;
        }
      } catch (err) {
        if (err instanceof OcrBookError) locked.add(row.id);
        else {
          serverError = true; // the server or the network: no use going on with the next book
          break;
        }
      }
      const status = statusOf.get(row.id);
      if (status) status.textContent = statusText(row);
      if (row.pages !== null && row.done >= row.pages) checked.delete(row.id); // a book not read to the end stays ticked, to be taken up again
    }
    await readers.close();
    running = false;
    abort.current = null;
    bar.hidden = progressLine.hidden = true;
    try {
      await refresh();
    } catch {
      draw();
    }
    say(serverError ? t("ocr.serverError") : controller.signal.aborted ? t("ocr.stopped", { n: read }) : t("ocr.finished", { n: read }), serverError);
    opts.changed?.();
  });

  take(list);
  if (opts.focus) checked.add(opts.focus.id);
  modal.body.replaceChildren(
    el("p", { class: "muted", textContent: t("ocr.intro") }),
    ...(ocrSupported() ? [] : [el("p", { class: "project-missing", textContent: t("ocr.unsupported") })]),
    ...(list.enabled ? [] : [el("p", { class: "project-missing", textContent: t("ocr.needIndex") })]),
    el("label", { class: "ocr-langline" }, el("span", { class: "muted small", textContent: t("ocr.lang") }), lang),
    tools,
    count,
    listEl,
    el("div", { class: "row project-buttons ocr-actions" }, selectUnread, start, stop),
    bar,
    progressLine,
    message,
    kept,
  );
  draw();
}
