import { expect, test } from "bun:test";
import { boxesOf, MAX_BOXES, type FoundBlock } from "./ocrBoxes";

const word = (text: string, x0: number, y0: number, x1: number, y1: number) => ({ text, bbox: { x0, y0, x1, y1 } });
const block = (...lines: ReturnType<typeof word>[][]): FoundBlock => ({ paragraphs: [{ lines: lines.map((words) => ({ words })) }] });

test("the words of a page come out in reading order with their frames as parts of the picture", () => {
  const found = [block([word("Лампа", 100, 200, 300, 250), word("схема", 320, 200, 500, 250)], [word("второй", 100, 260, 280, 310)]), block([word("Конец", 100, 900, 400, 950)])];
  expect(boxesOf(found, 1000, 1000)).toEqual([
    ["Лампа", 0.1, 0.2, 0.3, 0.25],
    ["схема", 0.32, 0.2, 0.5, 0.25],
    ["второй", 0.1, 0.26, 0.28, 0.31],
    ["Конец", 0.1, 0.9, 0.4, 0.95],
  ]);
  expect(boxesOf([block([word("a", 1, 1, 2, 2)])], 3, 7)).toEqual([["a", 0.3333, 0.1429, 0.6667, 0.2857]]); // four decimals are plenty for a page
});

test("frames reaching past the picture are held to it, and words with nothing to show or no area are left out", () => {
  const found = [block([word("край", -5, 10, 2000, 20), word("  ", 10, 10, 20, 20), word("нет", 30, 30, 30, 40), word("пусто", 50, 60, 60, 55), word("а б", 10, 10, 20, 20)])];
  expect(boxesOf(found, 1000, 100)).toEqual([
    ["край", 0, 0.1, 1, 0.2],
    ["аб", 0.01, 0.1, 0.02, 0.2], // a word has no space inside
  ]);
});

test("no blocks, or a picture with no size, give no frames; a halftone's dots are not sent without end", () => {
  expect(boxesOf(null, 100, 100)).toEqual([]);
  expect(boxesOf(undefined, 100, 100)).toEqual([]);
  expect(boxesOf([], 100, 100)).toEqual([]);
  expect(boxesOf([block([word("a", 0, 0, 1, 1)])], 0, 100)).toEqual([]);
  const dots = block(Array.from({ length: MAX_BOXES + 10 }, () => word("·", 0, 0, 1, 1)));
  expect(boxesOf([dots], 10, 10)).toHaveLength(MAX_BOXES);
});
