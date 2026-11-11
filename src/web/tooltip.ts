import { el } from "./ui";

/**
 * Hints for the buttons of a window, drawn by the page in the colours of its theme. The hint the browser makes of a `title` takes
 * the colours of the system (dark on a light page when the system is dark), and the page cannot change them.
 *
 * It works by delegation inside `root`, so nothing that builds the buttons has to change: when the pointer rests on an element
 * with a `title` (or a keyboard moves to it), the title is taken off for as long as it is there, so the browser shows no hint of its
 * own, and put back when the pointer leaves, so it still names and describes the element to a screen reader. Touch screens have
 * no hover and no hint, as with a `title`. Returns a function that takes the hints away (when the window closes).
 */
export function themedHints(root: HTMLElement, delay = 350): () => void {
  const tip = el("div", { class: "tip", id: "tapalog-tip", hidden: true });
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);
  let current: HTMLElement | null = null;
  let held = false; // the title of `current` is off, in data-tip
  let timer: ReturnType<typeof setTimeout> | null = null;

  const find = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>("[title], [data-tip]") : null);

  const place = (node: HTMLElement) => {
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, r.left), Math.max(margin, innerWidth - tip.offsetWidth - margin));
    let top = r.bottom + 6;
    if (top + tip.offsetHeight > innerHeight - margin) top = Math.max(margin, r.top - tip.offsetHeight - 6);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const leave = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    tip.hidden = true;
    if (current) {
      if (held && !current.hasAttribute("title")) current.setAttribute("title", current.dataset.tip ?? ""); // unless the title was set again meanwhile
      current.removeAttribute("aria-describedby");
      delete current.dataset.tip;
    }
    current = null;
    held = false;
  };

  const enter = (node: HTMLElement) => {
    if (node === current) return;
    leave();
    const text = node.getAttribute("title");
    if (!text) return;
    current = node;
    node.dataset.tip = text;
    node.removeAttribute("title");
    held = true;
    timer = setTimeout(() => {
      timer = null;
      tip.textContent = text;
      tip.hidden = false;
      place(node);
      node.setAttribute("aria-describedby", tip.id);
    }, delay);
  };

  const over = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const node = find(e.target);
    if (node) enter(node);
    else leave();
  };
  const focus = (e: FocusEvent) => {
    const node = find(e.target);
    if (node && (e.target as HTMLElement).matches(":focus-visible")) enter(node);
  };
  const stop = () => leave();
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") leave();
  };
  root.addEventListener("pointerover", over);
  root.addEventListener("pointerleave", stop);
  root.addEventListener("pointerdown", stop, true);
  root.addEventListener("focusin", focus);
  root.addEventListener("focusout", stop);
  root.addEventListener("scroll", stop, true);
  addEventListener("keydown", keys, true);
  return () => {
    leave();
    root.removeEventListener("pointerover", over);
    root.removeEventListener("pointerleave", stop);
    root.removeEventListener("pointerdown", stop, true);
    root.removeEventListener("focusin", focus);
    root.removeEventListener("focusout", stop);
    root.removeEventListener("scroll", stop, true);
    removeEventListener("keydown", keys, true);
    tip.remove();
  };
}
