import { describe, expect, test } from "bun:test";
import { clampSize, dragSize, expandedSize, GAP, MIN_H, MIN_W, parseSaved, sizeFor } from "./modalSize";

const screen = { w: 1600, h: 900 };

describe("the size of a window that can be changed", () => {
  test("the biggest window leaves the same space around it on every side", () => {
    expect(expandedSize(screen)).toEqual({ w: 1600 - 2 * GAP, h: 900 - 2 * GAP });
    expect(expandedSize({ w: 10, h: 10 })).toEqual({ w: 0, h: 0 });
  });

  test("a wanted size is kept between the smallest and the biggest", () => {
    expect(clampSize({ w: 100, h: 100 }, screen)).toEqual({ w: MIN_W, h: MIN_H });
    expect(clampSize({ w: 5000, h: 5000 }, screen)).toEqual(expandedSize(screen));
    expect(clampSize({ w: 1000.4, h: 600.6 }, screen)).toEqual({ w: 1000, h: 601 });
  });

  test("a screen too small for the smallest size gets all the room it has", () => {
    expect(clampSize({ w: 100, h: 100 }, { w: 500, h: 400 })).toEqual({ w: 452, h: 352 });
  });

  test("dragging an edge moves it with the pointer: the window grows on both sides", () => {
    const start = { w: 1000, h: 600 };
    expect(dragSize(start, { x: 1, y: 0 }, 50, 999, screen)).toEqual({ w: 1100, h: 600 }); // the right edge, 50 px out
    expect(dragSize(start, { x: -1, y: 0 }, -50, 0, screen)).toEqual({ w: 1100, h: 600 }); // the left edge, 50 px out
    expect(dragSize(start, { x: 0, y: 1 }, 999, -100, screen)).toEqual({ w: 1000, h: 400 + 20 }); // the bottom edge in: not below the smallest
    expect(dragSize(start, { x: 1, y: 1 }, 20, 20, screen)).toEqual({ w: 1040, h: 640 }); // a corner moves both
  });

  test("dragging cannot take the window past the space left around it", () => {
    expect(dragSize({ w: 1000, h: 600 }, { x: 1, y: 1 }, 5000, 5000, screen)).toEqual(expandedSize(screen));
  });

  test("what the browser kept is read back, and rubbish is not believed", () => {
    expect(parseSaved(null)).toBeNull();
    expect(parseSaved("")).toBeNull();
    expect(parseSaved("not json")).toBeNull();
    expect(parseSaved("42")).toBeNull();
    expect(parseSaved('{"expanded":true}')).toEqual({ expanded: true });
    expect(parseSaved('{"expanded":false,"w":900.4,"h":500}')).toEqual({ expanded: false, w: 900, h: 500 });
    expect(parseSaved('{"w":-5,"h":"x"}')).toEqual({ expanded: false });
  });

  test("the size to give: the style sheet's when nothing was chosen, the biggest when expanded, a chosen one brought inside the screen", () => {
    expect(sizeFor(null, screen)).toBeNull();
    expect(sizeFor({ expanded: false }, screen)).toBeNull();
    expect(sizeFor({ expanded: true, w: 800, h: 500 }, screen)).toEqual(expandedSize(screen));
    expect(sizeFor({ expanded: false, w: 900, h: 500 }, screen)).toEqual({ w: 900, h: 500 });
    expect(sizeFor({ expanded: false, w: 2400, h: 1400 }, { w: 1280, h: 720 })).toEqual(expandedSize({ w: 1280, h: 720 })); // a smaller screen than the one it was chosen on
  });
});
