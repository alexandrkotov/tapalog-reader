import { expect, test } from "bun:test";
import { rectToPage, rectToScreen, toPage, toScreen } from "./rotation";

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

test("the corners of a page go where a clockwise turn puts them", () => {
  // top-left of the file's page ends up top-right after 90, bottom-right after 180, bottom-left after 270
  expect(toScreen({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 });
  expect(toScreen({ x: 0, y: 0 }, 180)).toEqual({ x: 1, y: 1 });
  expect(toScreen({ x: 0, y: 0 }, 270)).toEqual({ x: 0, y: 1 });
  expect(toScreen({ x: 1, y: 0 }, 90)).toEqual({ x: 1, y: 1 });
  expect(toScreen({ x: 0.25, y: 0.5 }, 0)).toEqual({ x: 0.25, y: 0.5 });
});

test("turning to the screen and back is the identity for every turn", () => {
  for (const turn of [0, 90, 180, 270, 360, -90]) {
    const p = toPage(toScreen({ x: 0.2, y: 0.7 }, turn), turn);
    near(p.x, 0.2);
    near(p.y, 0.7);
    const r = rectToPage(rectToScreen({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, turn), turn);
    near(r.x, 0.1);
    near(r.y, 0.2);
    near(r.w, 0.3);
    near(r.h, 0.4);
  }
});

test("a rectangle keeps its area and swaps its sides on a quarter turn", () => {
  const r = rectToScreen({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 90);
  near(r.w, 0.4);
  near(r.h, 0.3);
  near(r.x, 0.4); // 1 - (0.2 + 0.4)
  near(r.y, 0.1);
});
