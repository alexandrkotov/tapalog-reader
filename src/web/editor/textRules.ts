/**
 * How the text of a page goes into the visual editor and comes back out of it. The text is Markdown in only a loose sense:
 * the recognizer writes plain lines (a single line break is a line break) and the figures cut from the scan, while a person may
 * add bold, headings and formulas. These rules keep what the editor does to the text from showing: nothing here touches the page.
 */
import { dropBreaks, outsideCode, scanDollars } from "../../shared/markup";

/**
 * Escapes every single `$` that does not belong to a formula, so a price ("costs $5 and $6") is not drawn as one.
 * `$$` blocks and a `$` already escaped are left as they are.
 */
export function protectDollars(text: string): string {
  return outsideCode(text, protectPlain);
}

function protectPlain(text: string): string {
  return text
    .split(/(\n[ \t]*\n+)/)
    .map((part, i) => (i % 2 ? part : protectParagraph(part)))
    .join("");
}

function protectParagraph(paragraph: string): string {
  if (paragraph.includes("$$")) {
    // a block formula is kept whole, the lines around it are read one by one
    return paragraph
      .split(/(\$\$[\s\S]*?\$\$)/)
      .map((piece, i) => (i % 2 ? piece : protectLine(piece)))
      .join("");
  }
  return protectLine(paragraph);
}

function protectLine(text: string): string {
  const prices = new Set(scanDollars(text).prices);
  if (!prices.size) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) out += prices.has(i) ? "\\$" : text[i];
  return out;
}

/**
 * What the editor wrote, as the page's text: no blank lines at either end (an empty paragraph is not text), no closing line break, a break the editor marks with a backslash is a plain line
 * break again (that is what a line break means in this text), and the signs the editor protected with a backslash so they would
 * not be read as marks (`3 \* 4`, `\[1]`, a price's `\$`) are plain again: the text is read by people, not by a Markdown program.
 */
export function fromEditor(markdown: string): string {
  const plain = (text: string) => text.replace(/\\\n/g, "\n").replace(/\\([*_[\]$])/g, "$1");
  return dropBreaks(outsideCode(markdown, plain)).replace(/^\n+|\n+$/g, ""); // a block of code is kept exactly as it was written
}

/** The text as the editor is given it (an empty paragraph, a line of `<br />` that older pages may hold, is not shown as one). */
export function toEditor(text: string): string {
  return protectDollars(dropBreaks(text));
}
