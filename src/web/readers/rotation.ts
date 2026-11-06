import type { Rect } from "./types";

/**
 * Pages are turned by whole quarters, clockwise. Everything that is stored (a view's position, an
 * area, a bookmark, a link) stays in the coordinates of the page as the file has it; these functions
 * only translate to and from what is on screen, and `turn` is 0, 90, 180 or 270.
 */
export interface Point {
  x: number;
  y: number;
}

/** A point of the page as the file has it -> the same point of the turned page, as fractions of its width and height. */
export function toScreen(p: Point, turn: number): Point {
  switch (((turn % 360) + 360) % 360) {
    case 90:
      return { x: 1 - p.y, y: p.x };
    case 180:
      return { x: 1 - p.x, y: 1 - p.y };
    case 270:
      return { x: p.y, y: 1 - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/** The opposite: a point of the turned page -> the page as the file has it. */
export function toPage(p: Point, turn: number): Point {
  switch (((turn % 360) + 360) % 360) {
    case 90:
      return { x: p.y, y: 1 - p.x };
    case 180:
      return { x: 1 - p.x, y: 1 - p.y };
    case 270:
      return { x: 1 - p.y, y: p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

function through(rect: Rect, map: (p: Point) => Point): Rect {
  const a = map({ x: rect.x, y: rect.y });
  const b = map({ x: rect.x + rect.w, y: rect.y + rect.h });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export const rectToScreen = (rect: Rect, turn: number): Rect => through(rect, (p) => toScreen(p, turn));
export const rectToPage = (rect: Rect, turn: number): Rect => through(rect, (p) => toPage(p, turn));
