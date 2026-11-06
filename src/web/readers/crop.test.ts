import { expect, test } from "bun:test";
import type { Rect } from "./types";
import { clipToCrop, cropFor, intoCrop, outOfCrop, rectIntoCrop, rectOutOfCrop } from "./crop";

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
