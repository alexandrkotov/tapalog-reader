import { termPattern } from "../found";

/**
 * Marks the words a search found on the page of a book it led to, with the browser's own highlighter (CSS highlights): nothing is
 * added to the page or changed in it, so the text layer of a PDF, the words laid over a scan and the text of a TXT stay as they are,
 * and a page drawn again by its viewer is marked again by calling `add` for it.
 */

const NAME = "tapalog-found";
/** No page is marked in more than this many places: a common word would otherwise make thousands of them. */
const LIMIT = 400;

export interface FoundMarks {
  /** Marks the words inside `root` (the page, the text); what was marked under `key` before is replaced. Returns how many places. */
  add(key: unknown, root: Node): number;
  /** Takes every mark away. */
  clear(): void;
}

/** Whether this browser can mark text this way (the others show the page as it is, without marks). */
export const canMark = (): boolean => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** The words to mark, or null when there is nothing to mark or the browser cannot do it. */
export function createFoundMarks(words: string[] | undefined): FoundMarks | null {
  const pattern = termPattern(words ?? []);
  if (!pattern || !canMark()) return null;
  const places = new Map<unknown, Range[]>();
  let revealed = false;

  const paint = () => {
    const all = [...places.values()].flat();
    if (all.length) CSS.highlights.set(NAME, new Highlight(...all));
    else CSS.highlights.delete(NAME);
  };

  return {
    add(key, root) {
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && ranges.length < LIMIT; node = walker.nextNode()) {
        const text = node.nodeValue ?? "";
        if (!text.trim()) continue;
        for (const m of text.matchAll(pattern)) {
          const range = new Range();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          ranges.push(range);
          if (ranges.length >= LIMIT) break;
        }
      }
      places.set(key, ranges);
      paint();
      if (!revealed && ranges.length) {
        // the first place found is brought into view once, so a word lower on the page is not left below the fold
        revealed = true;
        ranges[0]!.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
      }
      return ranges.length;
    },
    clear() {
      places.clear();
      CSS.highlights.delete(NAME);
    },
  };
}
