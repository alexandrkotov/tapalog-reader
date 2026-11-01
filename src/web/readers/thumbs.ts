import { el } from "../ui";

/**
 * A strip of page previews down the left side of a reader: one small box per page, drawn only when
 * it scrolls into view (a thousand-page book costs a thousand empty boxes, not a thousand renders),
 * one at a time so the page being read keeps the processor. Clicking a box goes to that page.
 */
export interface ThumbsOptions {
  count: number;
  /** Height / width of a page, used for the empty boxes until the real one is known. */
  ratio: number;
  /** Puts the picture of page `n` (1-based) into `box`. Should give up quietly when `signal` aborts. */
  draw(n: number, box: HTMLElement, signal: AbortSignal): Promise<void>;
  pick(n: number): void;
}

export interface Thumbs {
  el: HTMLElement;
  /** Marks the page being read and brings its box into view. */
  current(n: number): void;
  destroy(): void;
}

export function mountThumbs(options: ThumbsOptions): Thumbs {
  const root = el("div", { class: "thumbs" });
  const boxes: HTMLElement[] = [];
  const state = new Set<number>(); // pages drawn or being drawn
  const waiting: number[] = [];
  const stop = new AbortController();
  let drawing = false;
  let selected = 0;

  for (let n = 1; n <= options.count; n++) {
    const box = el("div", { class: "thumb-pic" });
    box.style.aspectRatio = `1 / ${options.ratio}`;
    const cell = el("button", { type: "button", class: "thumb-cell", title: String(n) }, box, el("span", { class: "thumb-n", textContent: String(n) }));
    cell.dataset.n = String(n);
    cell.addEventListener("click", () => options.pick(n));
    boxes.push(box);
    root.append(cell);
  }

  async function pump(): Promise<void> {
    if (drawing) return;
    drawing = true;
    try {
      while (waiting.length && !stop.signal.aborted) {
        const n = waiting.shift()!;
        const cell = boxes[n - 1]!;
        // a box that has already scrolled away again is left for when it returns
        if (!visible.has(n)) {
          state.delete(n);
          continue;
        }
        try {
          await options.draw(n, cell, stop.signal);
          cell.style.aspectRatio = "";
        } catch {
          state.delete(n); // tried again when it is next seen
        }
      }
    } finally {
      drawing = false;
    }
  }

  const visible = new Set<number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset.n);
        if (e.isIntersecting) {
          visible.add(n);
          if (!state.has(n)) {
            state.add(n);
            waiting.push(n);
          }
        } else visible.delete(n);
      }
      void pump();
    },
    { root, rootMargin: "300px 0px" },
  );
  for (const cell of root.children) observer.observe(cell);

  return {
    el: root,
    current(n) {
      if (n === selected) return;
      boxes[selected - 1]?.parentElement?.classList.remove("current");
      selected = n;
      const cell = boxes[n - 1]?.parentElement;
      if (!cell) return;
      cell.classList.add("current");
      // scrolls the strip only: scrollIntoView would also move the page behind it
      const top = cell.offsetTop - root.offsetTop;
      if (top < root.scrollTop || top + cell.offsetHeight > root.scrollTop + root.clientHeight) root.scrollTop = top - (root.clientHeight - cell.offsetHeight) / 2;
    },
    destroy() {
      stop.abort();
      observer.disconnect();
      root.remove();
    },
  };
}
