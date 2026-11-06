import type { Crop } from "../display";
import { t } from "../i18n";
import { dragFrame, inScope, startRect, withScope, type Handle, type Scope } from "./crop";
import { rectToPage, rectToScreen } from "./rotation";
import type { Rect } from "./types";

/** What the editor needs from the reader it works in. */
export interface CropHost {
  /** The page under the middle of the window. */
  page(): number;
  pageElement(n: number): HTMLElement | null;
  pageBox(n: number): { width: number; height: number } | null;
  /** How the pages are turned now (clockwise degrees). */
  turn(): number;
  /** The crop that is kept for the book. */
  committed(): Crop | undefined;
  /** Shows the pages with this crop (undefined: whole), keeping the place being read. Nothing is kept. */
  show(crop: Crop | undefined): void;
  /** Keeps this crop for the book. */
  keep(crop: Crop | undefined): void;
  /** Runs a change that moves or resizes the reading area, keeping the spot that is in the middle of the window. */
  holdPlace(change: () => void): void;
  /** Fits the whole page being read into the window, so the whole frame is in view. */
  fitPage(): void;
  /** The mode started or stopped; the reader leaves its other tools alone meanwhile. */
  onMode(active: boolean): void;
}

export interface CropEditor {
  /** The toolbar button that starts and (while active) leaves the mode without keeping anything. */
  button: HTMLButtonElement;
  /** The row of controls shown while the mode is active. */
  tools: HTMLElement;
  active(): boolean;
  cancel(): void;
  /** Puts the frame on the page being read; call after the page changed or was drawn again. */
  place(): void;
  destroy(): void;
}

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const EDGE_LABEL: Record<string, string> = { n: "pdf.cropTop", e: "pdf.cropRight", s: "pdf.cropBottom", w: "pdf.cropLeft" };
const STEP = 0.01;
const BIG_STEP = 0.05;

function control(label: string, title: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The mode in which the margins of a book's pages are cut away. The pages are shown whole with a frame on the
 * one being read: everything outside the frame is dimmed, its edges are dragged (or moved with the arrow keys
 * when focused) and **Preview** shows what is left. The frame is for all pages, or only the odd or even ones.
 * Nothing is kept until **Apply**; **Cancel** (and Esc) puts everything back, **Reset** drops the whole crop.
 */
export function createCropEditor(host: CropHost): CropEditor {
  let active = false;
  let previewing = false;
  let scope: Scope = "all";
  /** The frame, in the whole page as the file has it (so it survives turning the page). */
  let rect: Rect = { x: 0, y: 0, w: 1, h: 1 };

  const button = control(`✂ ${t("pdf.crop")}`, t("pdf.cropTitle"), () => (active ? cancel() : enter()));
  button.setAttribute("aria-pressed", "false");

  // ---------- the frame ----------

  const layer = document.createElement("div");
  layer.className = "pdf-crop-layer";
  const frame = document.createElement("div");
  frame.className = "pdf-crop";
  for (const h of HANDLES) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `pdf-crop-handle h-${h}`;
    handle.dataset.handle = h;
    const edge = EDGE_LABEL[h];
    if (edge) {
      handle.setAttribute("aria-label", t(edge as "pdf.cropTop"));
      handle.title = t("pdf.cropHandleTitle");
    } else {
      handle.tabIndex = -1; // corners are for the pointer; the four edges are the keyboard's way in
      handle.setAttribute("aria-hidden", "true");
    }
    frame.append(handle);
  }
  // the layer reaches a little beyond the page so the handles on the page's own edges are whole and can be grabbed
  const inner = document.createElement("div");
  inner.className = "pdf-crop-inner";
  inner.append(frame);
  layer.append(inner);

  const shown = (): Rect => rectToScreen(rect, host.turn());
  const setFromShown = (r: Rect) => (rect = rectToPage(r, host.turn()));

  function render(n: number): void {
    const r = shown();
    Object.assign(frame.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
    const mine = inScope(scope, n);
    layer.classList.toggle("off", !mine); // a page the edit is not for shows the frame, but it cannot be dragged there
    frame.toggleAttribute("inert", !mine);
  }

  function place(): void {
    const el = active && !previewing ? host.pageElement(host.page()) : null;
    if (!el) return layer.remove();
    if (layer.parentElement !== el) el.append(layer);
    render(host.page());
  }

  frame.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !active) return;
    const target = event.target as HTMLElement;
    const handle = (target.dataset.handle as Handle | undefined) ?? (target === frame ? "move" : undefined);
    const n = host.page();
    const box = host.pageBox(n);
    if (!handle || !box || box.width <= 0 || box.height <= 0) return;
    event.preventDefault();
    frame.setPointerCapture(event.pointerId);
    const start = shown();
    const x0 = event.clientX;
    const y0 = event.clientY;
    const move = (e: PointerEvent) => {
      setFromShown(dragFrame(start, handle, (e.clientX - x0) / box.width, (e.clientY - y0) / box.height));
      render(n);
    };
    const stop = () => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", stop);
      frame.removeEventListener("pointercancel", stop);
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", stop);
    frame.addEventListener("pointercancel", stop);
  });

  frame.addEventListener("keydown", (event) => {
    const handle = (event.target as HTMLElement).dataset.handle as Handle | undefined;
    if (!handle || !EDGE_LABEL[handle]) return;
    const step = event.shiftKey ? BIG_STEP : STEP;
    const sideways = handle === "w" || handle === "e";
    const delta = sideways ? { ArrowLeft: -step, ArrowRight: step }[event.key] : { ArrowUp: -step, ArrowDown: step }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    setFromShown(dragFrame(shown(), handle, sideways ? delta : 0, sideways ? 0 : delta));
    render(host.page());
  });

  // ---------- controls ----------

  const scopeButtons = (["all", "odd", "even"] as const).map((s) => {
    const b = control(t(`pdf.crop.${s}`), t(`pdf.crop.${s}Title`), () => pick(s));
    b.dataset.scope = s;
    return b;
  });
  const scopes = document.createElement("div");
  scopes.className = "pdf-crop-scopes";
  scopes.setAttribute("role", "group");
  scopes.setAttribute("aria-label", t("pdf.cropScope"));
  scopes.append(...scopeButtons);
  const previewButton = control(t("pdf.cropPreview"), t("pdf.cropPreviewTitle"), () => preview(!previewing));
  const resetButton = control(t("pdf.cropReset"), t("pdf.cropResetTitle"), () => reset());
  const applyButton = control(t("pdf.cropApply"), t("pdf.cropApplyTitle"), () => apply(), "primary");
  const cancelButton = control(t("pdf.cropCancel"), t("pdf.cropCancelTitle"), () => cancel());
  const hint = document.createElement("span");
  hint.className = "pdf-crop-hint";
  hint.textContent = t("pdf.cropHint");
  const tools = document.createElement("div");
  tools.className = "pdf-toolbar pdf-croptools";
  tools.hidden = true;
  tools.append(scopes, previewButton, resetButton, applyButton, cancelButton, hint);

  function paint(): void {
    for (const b of scopeButtons) {
      b.classList.toggle("active", b.dataset.scope === scope);
      b.setAttribute("aria-pressed", String(b.dataset.scope === scope));
    }
    previewButton.classList.toggle("active", previewing);
    previewButton.setAttribute("aria-pressed", String(previewing));
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  /** What the book would be cut like if the frame were applied now. */
  const pending = (): Crop | undefined => withScope(host.committed(), scope, rect);

  function pick(next: Scope): void {
    if (previewing) preview(false);
    scope = next;
    rect = startRect(host.committed(), scope);
    paint();
    place();
  }

  function preview(on: boolean): void {
    previewing = on;
    host.show(on ? pending() : undefined);
    paint();
    place();
  }

  function enter(): void {
    active = true;
    previewing = false;
    scope = "all";
    rect = startRect(host.committed(), scope);
    host.holdPlace(() => {
      tools.hidden = false; // the row of controls takes room from the pages
      host.onMode(true);
    });
    host.show(undefined); // the pages whole, to cut from
    host.fitPage();
    place();
    paint();
    place();
  }

  function leave(): void {
    active = false;
    previewing = false;
    layer.remove();
    host.holdPlace(() => {
      tools.hidden = true;
      host.onMode(false);
    });
    paint();
  }

  function apply(): void {
    const crop = pending();
    leave();
    host.show(crop);
    host.keep(crop);
  }

  function reset(): void {
    leave();
    host.show(undefined);
    host.keep(undefined);
  }

  function cancel(): void {
    if (!active) return;
    leave();
    host.show(host.committed());
  }

  paint();
  return { button, tools, active: () => active, cancel, place, destroy: () => (layer.remove(), (active = false)) };
}
