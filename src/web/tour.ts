import { el, store } from "./ui";
import { t, type Key } from "./i18n";

export interface TourStep {
  /** CSS selector of the element to point at; a step whose element isn't on screen is skipped. */
  target: string;
  text: Key;
}

const GAP = 10;
const MARGIN = 12;
const DONE_KEY = "tour";

function onScreen(node: HTMLElement | null): node is HTMLElement {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && getComputedStyle(node).visibility !== "hidden";
}

let stopTour: (() => void) | null = null;

/** Dims the page, lights up one element at a time and says what it is for; "Next" goes to the following one. */
export function startTour(steps: TourStep[]): void {
  stopTour?.();
  const items = steps.flatMap((step) => {
    const node = document.querySelector<HTMLElement>(step.target);
    return onScreen(node) ? [{ node, text: step.text }] : [];
  });
  if (!items.length) return;
  store.set(DONE_KEY, "1");

  const blocker = el("div", { class: "tour-blocker" }); // nothing behind the tour can be clicked
  const hole = el("div", { class: "tour-hole" });
  const text = el("p", { class: "tour-text" });
  const counter = el("span", { class: "tour-count" });
  const skip = el("button", { type: "button", class: "tour-skip", textContent: t("tour.skip") });
  const back = el("button", { type: "button", class: "btn", textContent: t("tour.back") });
  const next = el("button", { type: "button", class: "btn primary" });
  const card = el("div", { class: "tour-card", role: "dialog" }, el("div", { class: "tour-head" }, counter, skip), text, el("div", { class: "tour-actions" }, back, next));
  const before = document.activeElement as HTMLElement | null;
  let index = 0;

  const place = () => {
    const r = items[index]!.node.getBoundingClientRect();
    const pad = 4;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const width = Math.min(340, innerWidth - 2 * MARGIN);
    card.style.width = `${width}px`;
    const height = card.offsetHeight;
    const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max));
    let left = clamp(r.left, innerWidth - width - MARGIN);
    let top = r.bottom + pad + GAP; // below the element, else above it, else beside it
    if (top + height > innerHeight - MARGIN) top = r.top - pad - GAP - height;
    if (top < MARGIN) {
      left = r.right + pad + GAP + width + MARGIN <= innerWidth ? r.right + pad + GAP : clamp(r.left, innerWidth - width - MARGIN);
      top = clamp(r.top, innerHeight - height - MARGIN);
    }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
  };

  const show = () => {
    const { node, text: key } = items[index]!;
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
    text.textContent = t(key);
    counter.textContent = t("tour.step", { n: index + 1, total: items.length });
    back.hidden = index === 0;
    next.textContent = index === items.length - 1 ? t("tour.done") : t("tour.next");
    place();
    next.focus();
  };

  const close = () => {
    stopTour = null;
    clearInterval(follow);
    removeEventListener("resize", place);
    document.removeEventListener("keydown", onKey, true);
    blocker.remove();
    hole.remove();
    card.remove();
    before?.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  next.addEventListener("click", () => (index === items.length - 1 ? close() : (index++, show())));
  back.addEventListener("click", () => (index--, show()));
  skip.addEventListener("click", close);
  addEventListener("resize", place);
  const follow = setInterval(place, 200); // the top bar can change while the tour is open (a scan note appears and shifts the buttons)
  document.addEventListener("keydown", onKey, true);
  document.body.append(blocker, hole, card);
  stopTour = close;
  show();
}

/** A small, non-blocking card for a first visit: the tour is offered once, never forced. */
export function offerTour(start: () => void): void {
  document.querySelector(".tour-offer")?.remove();
  if (store.get(DONE_KEY)) return;
  const answer = (go: boolean) => {
    store.set(DONE_KEY, "1");
    card.remove();
    if (go) start();
  };
  const yes = el("button", { type: "button", class: "btn primary", textContent: t("tour.offer.yes") });
  const no = el("button", { type: "button", class: "btn", textContent: t("tour.offer.no") });
  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));
  const card = el("div", { class: "tour-offer", role: "dialog" }, el("p", { textContent: t("tour.offer") }), el("div", { class: "tour-actions" }, no, yes));
  document.body.append(card);
}
