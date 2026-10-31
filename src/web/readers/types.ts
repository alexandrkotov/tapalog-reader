/** A rectangle on one page, as fractions (0..1) of that page's width and height. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A "view" of a paged document (PDF, and later DJVU/CBZ): exactly what a reader
 * has on screen, in units that survive a different window size.
 *
 * - `zoom` 1 = the page is as wide as the window (minus its padding), the same
 *   idea as the viewer engine's zoom (1 = fitted) but fitted by width, which is
 *   what a scrolling column of pages wants.
 * - `cx`/`cy` = the point of the page at the middle of the window.
 * - `region` = a highlighted rectangle on `page`. A view with a region and no
 *   zoom is shown with the rectangle fitted into the window and centred.
 */
export interface PageView {
  v: 1;
  page: number;
  zoom?: number;
  cx?: number;
  cy?: number;
  region?: Rect;
}

export interface ReaderHandle {
  destroy(): void;
}
