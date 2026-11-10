/** The rules for cutting a figure out of a scan and for scrolling the list while a frame is being drawn; nothing here touches the page. */

/** A figure is cut from the PDF at up to this many pixels per point and no more than this many pixels on its longer side. */
export const FIGURE_MAX_SCALE = 4;
export const FIGURE_MAX_SIDE = 3200;
/** The server takes a picture of up to 12 MB (MAX_IMAGE_BYTES); a bigger one is cut again smaller, from this size on. */
export const MAX_PNG_BYTES = 11 * 1024 * 1024;
/** How many times a picture that is too big is cut again, each time smaller. */
export const MAX_ATTEMPTS = 5;

/**
 * The pixels per point to cut a framed part of a page at (`frame` is its share of the page, `page` the page in points).
 * `attempt` 0 is the sharpest the limits allow; each next one is 30% smaller, but not below one pixel per point.
 */
export function figureScale(frame: { w: number; h: number }, page: { width: number; height: number }, attempt = 0): number {
  const sharpest = Math.min(FIGURE_MAX_SCALE, FIGURE_MAX_SIDE / Math.max(frame.w * page.width, frame.h * page.height));
  return Math.max(Math.min(1, sharpest), sharpest * 0.7 ** attempt);
}

/** How near the edge of the list the pointer starts to scroll it, and the most it scrolls in one frame of the screen. */
export const SCROLL_EDGE = 48;
export const SCROLL_MAX_STEP = 24;

/**
 * How far to scroll the list now (negative: up) because the pointer is at height `y` while the list stands between `top`
 * and `bottom` on the screen: nothing in the middle, faster the nearer the edge, fastest (a bit more, up to one and a half
 * times) when the pointer is outside.
 */
export function scrollStep(y: number, top: number, bottom: number): number {
  if (y < top + SCROLL_EDGE) return -Math.round(SCROLL_MAX_STEP * Math.min(1.5, (top + SCROLL_EDGE - y) / SCROLL_EDGE));
  if (y > bottom - SCROLL_EDGE) return Math.round(SCROLL_MAX_STEP * Math.min(1.5, (y - (bottom - SCROLL_EDGE)) / SCROLL_EDGE));
  return 0;
}
