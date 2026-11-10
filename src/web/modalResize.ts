import { dragSize, type Box, type Grip, parseSaved, type SavedSize, sizeFor } from "./modalSize";
import { el, store } from "./ui";

/** The eight places on the frame of the window where it can be taken and stretched, with the edges each one moves. */
const GRIPS: [string, Grip][] = [
  ["n", { x: 0, y: -1 }],
  ["s", { x: 0, y: 1 }],
  ["e", { x: 1, y: 0 }],
  ["w", { x: -1, y: 0 }],
  ["nw", { x: -1, y: -1 }],
  ["ne", { x: 1, y: -1 }],
  ["sw", { x: -1, y: 1 }],
  ["se", { x: 1, y: 1 }],
];

const SVG = "http://www.w3.org/2000/svg";

/** A small picture for the button: one square to make the window bigger, two to take it back. */
function icon(expanded: boolean): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const square = (x: number, y: number, size: number) => {
    const rect = document.createElementNS(SVG, "rect");
    for (const [name, value] of Object.entries({ x, y, width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.5 })) rect.setAttribute(name, String(value));
    svg.append(rect);
  };
  if (expanded) {
    square(1.5, 4.5, 8);
    const line = document.createElementNS(SVG, "path");
    line.setAttribute("d", "M4.5 4.5V1.5H12.5V9.5H9.5");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.5");
    svg.append(line);
  } else square(1.5, 1.5, 11);
  return svg;
}

export interface Resizable {
  /** Stops listening to the screen; the window itself is removed by whoever closes it. */
  dispose(): void;
}

/**
 * Lets the window be stretched by its frame, and made as big as the screen allows (with a space left around it, so it
 * stays a window over the page) by a button or a double click on its title. The size is kept in the browser.
 * `scroller` is the list inside that scrolls: it is kept at the same place of the book while the size changes.
 */
export function makeResizable(box: HTMLElement, opts: { key: string; expandLabel: string; restoreLabel: string; scroller?: () => HTMLElement | null }): Resizable {
  const backdrop = box.parentElement;
  const head = box.querySelector<HTMLElement>(".modal-head");
  const close = head?.querySelector<HTMLElement>(".icon-btn");
  box.classList.add("sizable");
  backdrop?.classList.add("sizable");

  let saved: SavedSize | null = parseSaved(store.get(opts.key));
  const view = (): Box => ({ w: innerWidth, h: innerHeight });
  const persist = () => store.set(opts.key, JSON.stringify(saved));

  const button = el("button", { type: "button", class: "icon-btn modal-expand" });
  const paint = () => {
    const expanded = saved?.expanded === true;
    const label = expanded ? opts.restoreLabel : opts.expandLabel;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(expanded));
    button.replaceChildren(icon(expanded));
  };

  /** Remembers the place of the list in the book, to put it back once the rows have taken their new size. */
  const keepPlace = () => {
    const list = opts.scroller?.();
    const ratio = list && list.scrollHeight > 0 ? list.scrollTop / list.scrollHeight : 0;
    return () => {
      if (list && ratio > 0) list.scrollTop = ratio * list.scrollHeight;
    };
  };

  const give = (size: Box | null) => {
    box.style.width = size ? `${size.w}px` : "";
    box.style.height = size ? `${size.h}px` : "";
  };
  const apply = () => {
    const restore = keepPlace();
    give(sizeFor(saved, view()));
    restore();
    paint();
  };

  button.addEventListener("click", () => toggle());
  head?.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest("button")) toggle();
  });
  head?.insertBefore(button, close ?? null);
  function toggle(): void {
    // the size of its own that the window had stays kept, to come back to; without one it goes back to the style sheet's
    saved = { expanded: saved?.expanded !== true, w: saved?.w, h: saved?.h };
    persist();
    apply();
  }

  for (const [name, grip] of GRIPS) {
    const handle = el("div", { class: "modal-grip" });
    handle.dataset.grip = name;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const rect = box.getBoundingClientRect();
      const start = { w: rect.width, h: rect.height };
      const from = { x: e.clientX, y: e.clientY };
      const restore = keepPlace();
      const move = (ev: PointerEvent) => {
        const size = dragSize(start, grip, ev.clientX - from.x, ev.clientY - from.y, view());
        give(size);
        restore();
        saved = { expanded: false, w: size.w, h: size.h };
      };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        if (saved && !saved.expanded && saved.w) persist();
        paint();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
    box.append(handle);
  }

  const onScreen = () => apply(); // the screen changed: the biggest size follows it, a chosen one is brought back inside it
  addEventListener("resize", onScreen);
  apply();
  return { dispose: () => removeEventListener("resize", onScreen) };
}
