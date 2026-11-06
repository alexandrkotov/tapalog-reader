import { expect, test } from "bun:test";
import type { Rect } from "./types";
import { clipToCrop, cropFor, dragFrame, inScope, intoCrop, isWhole, outOfCrop, rectIntoCrop, rectOutOfCrop, startRect, withScope, WHOLE } from "./crop";

const c = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
const rounded = (r: Rect | null) => r && { x: Math.round(r.x * 1e6) / 1e6, y: Math.round(r.y * 1e6) / 1e6, w: Math.round(r.w * 1e6) / 1e6, h: Math.round(r.h * 1e6) / 1e6 };

test("odd and even pages take their own crop, and both fall back to the one for all", () => {
  const crop = { all: { x: 0, y: 0, w: 0.9, h: 0.9 }, odd: { x: 0.1, y: 0, w: 0.9, h: 1 } };
  expect(cropFor(crop, 1)).toEqual(crop.odd);
  expect(cropFor(crop, 3)).toEqual(crop.odd);
  expect(cropFor(crop, 2)).toEqual(crop.all);
  expect(cropFor({ even: crop.odd }, 1)).toBeNull();
  expect(cropFor(undefined, 1)).toBeNull();
});

test("a point goes into the crop and back where it started", () => {
  const mid = intoCrop({ x: 0.35, y: 0.4 }, c);
  expect(mid.x).toBeCloseTo(0.5);
  expect(mid.y).toBeCloseTo(0.5);
  const back = outOfCrop(intoCrop({ x: 0.3, y: 0.55 }, c), c);
  expect(back.x).toBeCloseTo(0.3);
  expect(back.y).toBeCloseTo(0.55);
  expect(intoCrop({ x: 0.3, y: 0.55 }, null)).toEqual({ x: 0.3, y: 0.55 });
  expect(intoCrop({ x: 0, y: 0 }, c).x).toBeLessThan(0); // outside the crop
});

test("a rectangle is clipped to the crop, and gone when it lies outside", () => {
  expect(rounded(clipToCrop({ x: 0, y: 0, w: 0.3, h: 0.5 }, c))).toEqual({ x: 0.1, y: 0.2, w: 0.2, h: 0.3 });
  expect(clipToCrop({ x: 0.7, y: 0.7, w: 0.2, h: 0.2 }, c)).toBeNull();
  expect(clipToCrop({ x: 0.7, y: 0.7, w: 0.2, h: 0.2 }, null)).toEqual({ x: 0.7, y: 0.7, w: 0.2, h: 0.2 });
  expect(rounded(rectOutOfCrop(rectIntoCrop({ x: 0.2, y: 0.3, w: 0.1, h: 0.1 }, c), c))).toEqual({ x: 0.2, y: 0.3, w: 0.1, h: 0.1 });
});


test("pages belong to a scope by their number", () => {
  expect([1, 2, 3, 4].map((n) => inScope("all", n))).toEqual([true, true, true, true]);
  expect([1, 2, 3, 4].map((n) => inScope("odd", n))).toEqual([true, false, true, false]);
  expect([1, 2, 3, 4].map((n) => inScope("even", n))).toEqual([false, true, false, true]);
});

test("a crop for the whole book replaces odd and even ones, which sit beside each other and win over it", () => {
  const a = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const b = { x: 0, y: 0.2, w: 0.7, h: 0.7 };
  const both = withScope(withScope(undefined, "odd", a), "even", b);
  expect(both).toEqual({ odd: a, even: b });
  expect(withScope(both, "all", a)).toEqual({ all: a });
  expect(withScope({ all: a }, "odd", b)).toEqual({ all: a, odd: b });
  expect(withScope({ all: a, odd: b }, "odd", WHOLE)).toEqual({ all: a }); // the whole page is no crop
  expect(withScope({ all: a }, "all", WHOLE)).toBeUndefined();
  expect(withScope(undefined, "odd", { x: 0.123456, y: 0, w: 0.5, h: 1 })).toEqual({ odd: { x: 0.1235, y: 0, w: 0.5, h: 1 } });
});

test("a scope starts from its own crop, else from what its pages show now, else the whole page", () => {
  const a = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  expect(startRect(undefined, "all")).toEqual(WHOLE);
  expect(startRect({ all: a }, "all")).toEqual(a);
  expect(startRect({ all: a }, "odd")).toEqual(a); // the pages of that scope show it now
  expect(startRect({ even: a }, "odd")).toEqual(WHOLE);
  expect(isWhole(WHOLE)).toBe(true);
  expect(isWhole(a)).toBe(false);
});

test("dragging a handle moves that edge only, and the frame never leaves the page or gets thinner than the minimum", () => {
  const f = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  const w = dragFrame(f, "w", 0.1, 0.5);
  expect(w.x).toBeCloseTo(0.3);
  expect(w.w).toBeCloseTo(0.5);
  expect(w.y).toBeCloseTo(0.2); // the vertical drag did nothing to a side handle
  expect(w.h).toBeCloseTo(0.6);
  const se = dragFrame(f, "se", 0.5, 0.5); // runs into the page edge
  expect(se.x + se.w).toBeCloseTo(1);
  expect(se.y + se.h).toBeCloseTo(1);
  const thin = dragFrame(f, "e", -0.9, 0); // would pass the opposite edge
  expect(thin.w).toBeCloseTo(0.05);
  expect(thin.x).toBeCloseTo(0.2);
  const moved = dragFrame(f, "move", 0.9, -0.9);
  expect(moved.x).toBeCloseTo(0.4);
  expect(moved.y).toBe(0);
  expect([moved.w, moved.h]).toEqual([0.6, 0.6]);
});
