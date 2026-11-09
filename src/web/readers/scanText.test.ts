import { expect, test } from "bun:test";
import type { OcrBox } from "../ocrBoxes";
import { framedIn, layoutScanText } from "./scanText";

/** Every letter is half an em wide. */
const measure = (text: string) => text.length * 0.5;

test("words on one row make a line, a word below starts the next, and the order is the order given", () => {
  const boxes: OcrBox[] = [
    ["Лампа", 0.1, 0.2, 0.3, 0.25],
    ["схема", 0.32, 0.205, 0.5, 0.255],
    ["вторая", 0.1, 0.3, 0.3, 0.35],
    ["строка", 0.32, 0.3, 0.5, 0.35],
  ];
  const lines = layoutScanText(boxes, 1, measure);
  expect(lines.map((l) => l.words.map((w) => w.text))).toEqual([["Лампа", "схема"], ["вторая", "строка"]]);
  expect(lines.map((l) => [l.left, l.top])).toEqual([[10, 20.25], [10, 30]]); // a line starts at the middle of its words' tops
});

test("a word's text is as wide as its frame, and the space before it makes up the rest", () => {
  // a frame 0.2 wide and 0.05 high on a square page: the font is 0.04, five letters of half an em are 0.1 wide, so the text is stretched twofold
  const [line] = layoutScanText([["Лампа", 0.1, 0.2, 0.3, 0.25], ["схема", 0.32, 0.2, 0.5, 0.25]], 1, measure);
  const [first, second] = line!.words;
  expect(first).toEqual({ text: "Лампа", margin: 0, top: 0, width: 10, scale: 2, height: 5, font: 4 });
  // the next word starts where the first one's text would end (0.1 + 0.1), so its space is the 0.12 that is left
  expect(second).toMatchObject({ text: "схема", margin: 12, width: 10 });
  expect(second!.scale).toBeCloseTo(1.8, 3);
});

test("the page's shape counts: on a page twice as wide as it is high the same letters take half the width of the frame", () => {
  const [line] = layoutScanText([["Лампа", 0.1, 0.2, 0.3, 0.25]], 2, measure);
  expect(line!.words[0]).toMatchObject({ width: 5, scale: 4 }); // 0.1 / 2 of the width, and the frame is 0.2 of it
});

test("the words of a line share its height, taken from the middle of them: a short word is as tall as the rest and a tall bracket does not stretch the band", () => {
  const [line] = layoutScanText([["не", 0.1, 0.22, 0.15, 0.25], ["который", 0.2, 0.2, 0.4, 0.26], ["(", 0.42, 0.18, 0.44, 0.3]], 1, measure);
  expect(line!.top).toBe(20); // the middle of the three tops (0.22, 0.2, 0.18), and of the three bottoms (0.25, 0.26, 0.3): 0.26
  expect(line!.words.map((w) => [w.top, w.height, w.font])).toEqual([[0, 6, 4.8], [0, 6, 4.8], [0, 6, 4.8]]);
});

test("a stretch beyond what a word could need is held, and frames with no area or words with no width are left out", () => {
  const [line] = layoutScanText([["и", 0.1, 0.2, 0.9, 0.25], ["ввв", 0.1, 0.3, 0.101, 0.35], ["x", 0.5, 0.5, 0.5, 0.6], ["", 0.1, 0.7, 0.2, 0.75]], 1, measure);
  expect(line!.words[0]!.scale).toBe(5);
  const rest = layoutScanText([["ввв", 0.1, 0.3, 0.101, 0.35]], 1, measure);
  expect(rest[0]!.words[0]!.scale).toBe(0.2);
  expect(layoutScanText([["x", 0.5, 0.5, 0.5, 0.6], ["", 0.1, 0.7, 0.2, 0.75]], 1, measure)).toEqual([]);
  expect(layoutScanText([], 1, measure)).toEqual([]);
});

test("a cut of the page shows the words in its own parts, holds the ones it cuts through to it, and drops the ones outside", () => {
  const boxes: OcrBox[] = [["внутри", 0.3, 0.3, 0.5, 0.35], ["снаружи", 0.05, 0.3, 0.15, 0.35], ["на границе", 0.15, 0.5, 0.35, 0.55]];
  const cut = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
  const [inside, border] = framedIn(boxes, cut);
  expect(framedIn(boxes, cut)).toHaveLength(2);
  expect(inside![1]).toBeCloseTo(0.1667, 3);
  expect(inside![2]).toBeCloseTo(0.1667, 3);
  expect(border![1]).toBe(0); // cut at the edge
  expect(framedIn(boxes, null)).toBe(boxes);
});
