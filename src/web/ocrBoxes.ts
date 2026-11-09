/**
 * The frames of the words the recognizer found on a page, in the form the server keeps and the reader lays over the scan:
 * each word with its corners as parts of the picture's width and height, from the top left. The picture the page was read
 * from is the page as drawn (with its own turn), so the same parts fit the page the reader shows.
 */

export type OcrBox = [word: string, x0: number, y0: number, x1: number, y1: number];

/** A page holds a few thousand words at most; the server keeps no more than this, so more are not sent. */
export const MAX_BOXES = 8000;

/** What is used of the recognizer's answer: blocks of paragraphs of lines of words, each with a frame in pixels. */
export interface FoundBlock {
  paragraphs: { lines: { words: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[];
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** The words of a page in reading order with their frames; the ones with nothing to show or no area are left out. */
export function boxesOf(blocks: FoundBlock[] | null | undefined, width: number, height: number): OcrBox[] {
  const out: OcrBox[] = [];
  if (!blocks || !(width > 0) || !(height > 0)) return out;
  for (const block of blocks)
    for (const paragraph of block.paragraphs)
      for (const line of paragraph.lines)
        for (const word of line.words) {
          const text = word.text.replace(/\s+/g, "");
          const { x0, y0, x1, y1 } = word.bbox;
          if (!text || !(x1 > x0) || !(y1 > y0)) continue;
          if (out.length >= MAX_BOXES) return out;
          out.push([text, round(Math.max(0, x0) / width), round(Math.max(0, y0) / height), round(Math.min(width, x1) / width), round(Math.min(height, y1) / height)]);
        }
  return out;
}
