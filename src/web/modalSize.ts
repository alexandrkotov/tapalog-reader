/** The rules for the size of a window that can be made bigger or smaller: nothing here touches the page, so they can be tested alone. */

/** A size in pixels. */
export interface Box {
  w: number;
  h: number;
}

/** The space left around the biggest window, so that it still looks like a window over the page. */
export const GAP = 24;
/** The smallest the window can be made, as long as the screen has room for that. */
export const MIN_W = 640;
export const MIN_H = 420;

/** What is kept between visits: a window made as big as the screen allows, or one of a size of its own. */
export interface SavedSize {
  expanded: boolean;
  w?: number;
  h?: number;
}

const between = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

/** The biggest the window can be on a screen of this size. */
export function expandedSize(view: Box): Box {
  return { w: Math.max(0, Math.floor(view.w - 2 * GAP)), h: Math.max(0, Math.floor(view.h - 2 * GAP)) };
}

/** A wanted size brought inside what the screen allows (a screen smaller than the minimum gets the whole of the room it has). */
export function clampSize(want: Box, view: Box): Box {
  const max = expandedSize(view);
  return { w: Math.round(between(want.w, Math.min(MIN_W, max.w), max.w)), h: Math.round(between(want.h, Math.min(MIN_H, max.h), max.h)) };
}

/** Which edges a grip moves: -1 the left or top one, 1 the right or bottom one, 0 not that direction. */
export interface Grip {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

/**
 * The size after a grip has been dragged by `dx` and `dy` from where the window was. The window stays in the middle of
 * the screen, so it grows on both sides and the edge that is held follows the pointer.
 */
export function dragSize(start: Box, grip: Grip, dx: number, dy: number, view: Box): Box {
  return clampSize({ w: start.w + 2 * grip.x * dx, h: start.h + 2 * grip.y * dy }, view);
}

/** What the browser kept, or null when it is missing or not something we wrote. */
export function parseSaved(raw: string | null): SavedSize | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<SavedSize> | null;
    if (!data || typeof data !== "object") return null;
    const size = Number.isFinite(data.w) && Number.isFinite(data.h) && data.w! > 0 && data.h! > 0 ? { w: Math.round(data.w!), h: Math.round(data.h!) } : {};
    return { expanded: data.expanded === true, ...size };
  } catch {
    return null;
  }
}

/** The size to give the window now, or null to leave it to the style sheet. */
export function sizeFor(saved: SavedSize | null, view: Box): Box | null {
  if (!saved) return null;
  if (saved.expanded) return expandedSize(view);
  return saved.w && saved.h ? clampSize({ w: saved.w, h: saved.h }, view) : null;
}
