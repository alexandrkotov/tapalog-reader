import { describe, expect, test } from "bun:test";
import { figureScale, FIGURE_MAX_SCALE, FIGURE_MAX_SIDE, MAX_ATTEMPTS, scrollStep, SCROLL_EDGE, SCROLL_MAX_STEP } from "./proofFigure";

const a4 = { width: 595, height: 842 };

describe("the scale a figure is cut at", () => {
  test("a small part of a page is cut at the highest scale", () => {
    expect(figureScale({ w: 0.2, h: 0.2 }, a4)).toBe(FIGURE_MAX_SCALE);
  });

  test("a whole page is held to the longest side the limits allow", () => {
    const scale = figureScale({ w: 1, h: 1 }, a4);
    expect(scale).toBeCloseTo(FIGURE_MAX_SIDE / 842, 6);
    expect(Math.round(842 * scale)).toBe(FIGURE_MAX_SIDE);
  });

  test("each next attempt is smaller, and not below one pixel per point", () => {
    const scales = Array.from({ length: MAX_ATTEMPTS }, (_, i) => figureScale({ w: 1, h: 1 }, a4, i));
    for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeLessThanOrEqual(scales[i - 1]!);
    expect(scales[1]).toBeCloseTo(scales[0]! * 0.7, 6);
    expect(scales.at(-1)).toBe(1);
    expect(figureScale({ w: 1, h: 1 }, a4, 50)).toBe(1);
  });

  test("a page so big that even the first attempt is under one pixel per point is not cut any smaller", () => {
    const huge = { width: 20000, height: 30000 }; // 3200 / 30000 of a pixel per point
    const first = figureScale({ w: 1, h: 1 }, huge, 0);
    expect(first).toBeLessThan(1);
    expect(figureScale({ w: 1, h: 1 }, huge, 3)).toBe(first);
  });
});

describe("scrolling the list while a frame is drawn", () => {
  const top = 100;
  const bottom = 600;

  test("nothing happens while the pointer is in the middle of the list", () => {
    expect(scrollStep(350, top, bottom)).toBe(0);
    expect(scrollStep(top + SCROLL_EDGE, top, bottom)).toBe(0);
    expect(scrollStep(bottom - SCROLL_EDGE, top, bottom)).toBe(0);
  });

  test("near the bottom the list goes down, faster the nearer the edge", () => {
    const slow = scrollStep(bottom - SCROLL_EDGE + 10, top, bottom);
    const fast = scrollStep(bottom - 5, top, bottom);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);
    expect(scrollStep(bottom, top, bottom)).toBe(SCROLL_MAX_STEP);
  });

  test("near the top the list goes up", () => {
    expect(scrollStep(top + 5, top, bottom)).toBeLessThan(0);
    expect(scrollStep(top, top, bottom)).toBe(-SCROLL_MAX_STEP);
  });

  test("outside the list it is faster still, but only by half and not without end", () => {
    expect(scrollStep(bottom + 20, top, bottom)).toBeGreaterThan(SCROLL_MAX_STEP);
    expect(scrollStep(bottom + 10_000, top, bottom)).toBe(Math.round(SCROLL_MAX_STEP * 1.5));
    expect(scrollStep(top - 10_000, top, bottom)).toBe(-Math.round(SCROLL_MAX_STEP * 1.5));
  });
});
