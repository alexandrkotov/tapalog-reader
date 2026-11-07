import { loadDisplay } from "./display";
import { el } from "./ui";

/** What a project item needs to be pictured. */
export interface PictureItem {
  id: number;
  title: string;
  bookId: string | null;
  view: unknown;
  book: { ext: string } | null;
  missing: boolean;
}

export interface Pictures {
  /**
   * Fills `slot` (an empty element that stays in the page) with a button showing the picture of the item once the
   * slot comes into view; the button calls `open`. Formats that cannot be pictured leave the slot empty.
   */
  show(slot: HTMLElement, item: PictureItem, open: () => void): void;
  destroy(): void;
}

/**
 * Pictures of the areas that project items point at. They are drawn here, in the browser, from the book file the
 * reader may open anyway, one at a time and only for items that scroll into view; nothing is stored. Only PDF
 * can be pictured: a catalog's engine draws no picture of an area, and its pictures stay behind its own password.
 */
export function createPictures(): Pictures {
  const stop = new AbortController();
  const done = new Map<string, HTMLCanvasElement>(); // an item redrawn after an edit keeps its picture
  const sources = new Map<string, Promise<import("./readers/pdfRegion").PdfPictures>>();
  const turns = new Map<string, Promise<number>>();
  const waiting: (() => Promise<void>)[] = [];
  let busy = false;

  const next = async () => {
    if (busy) return;
    busy = true;
    for (let job = waiting.shift(); job && !stop.signal.aborted; job = waiting.shift()) await job().catch(() => undefined); // one failed picture must not stop the rest
    busy = false;
  };
  const queue = (job: () => Promise<void>) => {
    waiting.push(job);
    void next();
  };

  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      watcher.unobserve(entry.target);
      (entry.target as HTMLElement & { draw?: () => void }).draw?.();
    }
  });

  const turnOf = (bookId: string) => {
    let turn = turns.get(bookId);
    if (!turn) turns.set(bookId, (turn = loadDisplay(true, bookId).then((d) => d.rotation ?? 0)));
    return turn;
  };
  const sourceOf = (bookId: string) => {
    let source = sources.get(bookId);
    if (!source) sources.set(bookId, (source = import("./readers/pdfRegion").then((m) => m.openPdfPictures(`/api/file/${bookId}`))));
    return source;
  };

  return {
    show(box, item, open) {
      if (!item.bookId || item.missing || item.book?.ext !== "pdf") return;
      const bookId = item.bookId;
      const key = `${item.id}|${JSON.stringify(item.view)}`;
      const show = (canvas: HTMLCanvasElement) => {
        const button = el("button", { type: "button", class: "project-thumb", title: item.title }, canvas);
        button.addEventListener("click", open);
        box.replaceChildren(button);
      };
      const known = done.get(key);
      if (known) return show(known);
      Object.assign(box, {
        draw: () =>
          queue(async () => {
            if (stop.signal.aborted || !box.isConnected) return; // the screen moved on while it waited
            const turn = await turnOf(bookId);
            const canvas = await (await sourceOf(bookId)).picture(item.view, turn, stop.signal);
            if (!canvas) return;
            done.set(key, canvas);
            if (box.isConnected) show(canvas);
          }),
      });
      watcher.observe(box);
    },
    destroy() {
      stop.abort();
      watcher.disconnect();
      waiting.length = 0;
      for (const source of sources.values()) void source.then((s) => s.close());
    },
  };
}
