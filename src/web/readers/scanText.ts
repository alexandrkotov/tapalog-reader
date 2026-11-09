import type { OcrBox } from "../ocrBoxes";
import { clipToCrop, rectIntoCrop } from "./crop";
import type { Rect } from "./types";

/**
 * Lays the words the recognizer found on a scan out as text the browser can select: each line is a row of words, every word as
 * wide as its frame on the page, drawn in no colour over the picture. Nothing here touches the page; the sizes are
 * percentages of the frame the words sit in (its width for what runs along, its height for the rest), so they hold at every zoom.
 */

/** A word's font is this much of its line's height: the frame holds the tallest letter and the longest tail. */
const FONT_RATIO = 0.8;
/** A word is stretched or squeezed to its frame, but never more than this: a frame that is far off the word's own proportions is not to be believed. */
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
/** A word belongs to the line before it when they share at least this much of the lower one's height. */
const SAME_LINE = 0.5;

export interface ScanWord {
  text: string;
  /** Space before the word, from where the last one's text ends (a width, % of the frame's width). */
  margin: number;
  /** How far below the top of its line the word's frame starts (% of the frame's height); the words of a line share one height, so what is selected is an even band. */
  top: number;
  /** The width the word's text has before it is stretched, and the stretch that fits it to its frame. */
  width: number;
  scale: number;
  /** Height of the word's frame and size of its letters (% of the frame's height). */
  height: number;
  font: number;
}

export interface ScanLine {
  /** Where the line starts, from the top left of the frame (% of its width and height). */
  left: number;
  top: number;
  words: ScanWord[];
}

const pct = (n: number) => Math.round(n * 100000) / 1000;

/** The middle value (the mean of the two middle ones for an even count): one tall bracket or short word does not move it. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The frames of the words (as parts of the whole page) in the shape a cut of the page shows them: held to the cut, in its
 * own parts, the ones that fall outside it dropped. Without a cut they stay as they are.
 */
export function framedIn(boxes: OcrBox[], cut: Rect | null): OcrBox[] {
  if (!cut) return boxes;
  const out: OcrBox[] = [];
  for (const [text, x0, y0, x1, y1] of boxes) {
    const inside = clipToCrop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, cut);
    if (!inside) continue;
    const r = rectIntoCrop(inside, cut);
    out.push([text, r.x, r.y, r.x + r.w, r.y + r.h]);
  }
  return out;
}

/**
 * The lines of a page, in reading order. `boxes` are as parts of the frame, `aspect` is the frame's width over its height, and
 * `measure` gives the width of a word in ems for the font the words are drawn in.
 */
export function layoutScanText(boxes: OcrBox[], aspect: number, measure: (text: string) => number): ScanLine[] {
  const groups: { last: OcrBox; boxes: OcrBox[] }[] = [];
  for (const box of boxes) {
    const [, x0, y0, x1, y1] = box;
    if (!(x1 > x0) || !(y1 > y0)) continue;
    const current = groups.at(-1);
    if (current) {
      const [, lx0, ly0, , ly1] = current.last;
      const shared = Math.min(y1, ly1) - Math.max(y0, ly0);
      if (shared >= SAME_LINE * Math.min(y1 - y0, ly1 - ly0) && x0 >= lx0) {
        current.boxes.push(box);
        current.last = box;
        continue;
      }
    }
    groups.push({ last: box, boxes: [box] });
  }

  const lines: ScanLine[] = [];
  for (const group of groups) {
    const left = group.boxes[0]![1];
    // a word's frame is cut to its letters, so "не" is lower than "который": the line's own height, from the middle of its words, is what they all get
    let top = median(group.boxes.map((b) => b[2]));
    let bottom = median(group.boxes.map((b) => b[4]));
    if (!(bottom > top)) {
      top = Math.min(...group.boxes.map((b) => b[2]));
      bottom = Math.max(...group.boxes.map((b) => b[4]));
    }
    let cursor = left;
    const words: ScanWord[] = [];
    for (const [text, x0, , x1] of group.boxes) {
      const ems = measure(text);
      if (!(ems > 0)) continue;
      const font = (bottom - top) * FONT_RATIO;
      const natural = (ems * font) / aspect; // as a part of the frame's width
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (x1 - x0) / natural));
      words.push({ text, margin: pct(x0 - cursor), top: 0, width: pct(natural), scale: Math.round(scale * 1000) / 1000, height: pct(bottom - top), font: pct(font) });
      cursor = x0 + natural;
    }
    if (words.length) lines.push({ left: pct(left), top: pct(top), words });
  }
  return lines;
}
