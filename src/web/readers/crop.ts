import type { Crop } from "../display";
import type { Point } from "./rotation";
import type { Rect } from "./types";

/**
 * Cropping shows only a rectangle of each page. Everything that is stored (a view's position, an area,
 * a bookmark, a link) stays in the whole page as the file has it; these functions translate to and from the
 * cropped page, whose own fractions run 0..1 across the rectangle that is left.
 */

/** The rectangle shown of page `n` (1-based; page 1 is odd), or null when the page is shown whole. */
export function cropFor(crop: Crop | undefined, n: number): Rect | null {
  if (!crop) return null;
  return (n % 2 === 1 ? crop.odd : crop.even) ?? crop.all ?? null;
}

/** A point of the whole page -> the same point of the cropped page (outside 0..1 when the crop does not contain it). */
export function intoCrop(p: Point, c: Rect | null): Point {
  return c ? { x: (p.x - c.x) / c.w, y: (p.y - c.y) / c.h } : p;
}

/** The opposite: a point of the cropped page -> the whole page. */
export function outOfCrop(p: Point, c: Rect | null): Point {
  return c ? { x: c.x + p.x * c.w, y: c.y + p.y * c.h } : p;
}

/** The part of `rect` that lies inside the crop, in whole-page fractions, or null when nothing of it does. */
export function clipToCrop(rect: Rect, c: Rect | null): Rect | null {
  if (!c) return rect;
  const x0 = Math.max(rect.x, c.x);
  const y0 = Math.max(rect.y, c.y);
  const x1 = Math.min(rect.x + rect.w, c.x + c.w);
  const y1 = Math.min(rect.y + rect.h, c.y + c.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export const rectIntoCrop = (rect: Rect, c: Rect | null): Rect => (c ? { x: (rect.x - c.x) / c.w, y: (rect.y - c.y) / c.h, w: rect.w / c.w, h: rect.h / c.h } : rect);
export const rectOutOfCrop = (rect: Rect, c: Rect | null): Rect => (c ? { x: c.x + rect.x * c.w, y: c.y + rect.y * c.h, w: rect.w * c.w, h: rect.h * c.h } : rect);

// ---------- editing a crop ----------

/** Which pages an edit is for. */
export type Scope = "all" | "odd" | "even";

/** The smallest side of a crop, as a fraction of the page (the server refuses less). */
export const MIN_CROP = 0.05;

export const WHOLE: Rect = { x: 0, y: 0, w: 1, h: 1 };
export const isWhole = (r: Rect): boolean => r.x <= 0.0005 && r.y <= 0.0005 && r.w >= 0.999 && r.h >= 0.999;

/** Whether a page takes part in an edit of this scope. */
export const inScope = (scope: Scope, n: number): boolean => scope === "all" || (scope === "odd") === (n % 2 === 1);

/** What the frame starts from when a scope is picked: that scope's own crop, else what its pages show now, else the whole page. */
export const startRect = (crop: Crop | undefined, scope: Scope): Rect => (scope === "all" ? crop?.all : cropFor(crop, scope === "odd" ? 1 : 2)) ?? WHOLE;

/**
 * The crop that results from putting `rect` on `scope`. A crop for the whole book replaces any odd/even ones
 * (every page is cut the same); a crop for odd or even pages sits beside the others and wins over the one for all.
 * A rectangle that is the whole page removes that scope's crop. Returns undefined when nothing is cut.
 */
export function withScope(crop: Crop | undefined, scope: Scope, rect: Rect): Crop | undefined {
  const next: Crop = scope === "all" ? {} : { ...crop };
  if (isWhole(rect)) delete next[scope];
  else next[scope] = { x: round4(rect.x), y: round4(rect.y), w: round4(rect.w), h: round4(rect.h) };
  return Object.keys(next).length ? next : undefined;
}
const round4 = (n: number) => Math.round(n * 10000) / 10000;

export type Handle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw" | "move";

/**
 * The frame after one of its handles was dragged by (dx, dy), in fractions of the page as shown. The frame
 * stays on the page and keeps at least MIN_CROP on each side; "move" slides it without changing its size.
 */
export function dragFrame(start: Rect, handle: Handle, dx: number, dy: number, min = MIN_CROP): Rect {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  if (handle === "move") return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (handle.includes("w")) x0 = clamp(start.x + dx, 0, x1 - min);
  if (handle.includes("e")) x1 = clamp(x1 + dx, x0 + min, 1);
  if (handle.includes("n")) y0 = clamp(start.y + dy, 0, y1 - min);
  if (handle.includes("s")) y1 = clamp(y1 + dy, y0 + min, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
