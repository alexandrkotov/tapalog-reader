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
