/**
 * How the text of a page goes into the visual editor and comes back out of it. The text is Markdown in only a loose sense:
 * the recognizer writes plain lines (a single line break is a line break) and the figures cut from the scan, while a person may
 * add bold, headings and formulas. These rules keep what the editor does to the text from showing: nothing here touches the page.
 */

/** A `$` opens a formula as pandoc reads it when no space follows it, and closes one when no space comes before it and no digit after it; an opening one that meets another opening one before any end is a price, not a formula. */
const SPACE = /\s/;

/**
 * Escapes every single `$` that does not belong to a formula, so a price ("costs $5 and $6") is not drawn as one.
 * `$$` blocks and a `$` already escaped are left as they are.
 */
export function protectDollars(text: string): string {
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
  // the single dollars of the text: not escaped, not part of a pair of them
  const marks: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$") continue;
    if (text[i + 1] === "$") {
      i++;
      continue;
    }
    if (text[i - 1] === "\\") continue;
    marks.push(i);
  }
  const escape = new Set<number>();
  for (let k = 0; k < marks.length; k++) {
    const open = marks[k]!;
    const next = text[open + 1];
    if (next === undefined || SPACE.test(next)) {
      escape.add(open);
      continue;
    }
    let close = -1;
    for (let j = k + 1; j < marks.length; j++) {
      const at = marks[j]!;
      const before = text[at - 1];
      const after = text[at + 1];
      const closes = before !== undefined && !SPACE.test(before) && !(after !== undefined && /\d/.test(after));
      if (closes) {
        close = j;
        break;
      }
      // a dollar that opens a formula of its own (a space before, none after): the one before it had no end
      if ((before === undefined || SPACE.test(before)) && after !== undefined && !SPACE.test(after)) break;
    }
    if (close < 0) escape.add(open);
    else k = close; // a formula: both marks stay
  }
  if (!escape.size) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) out += escape.has(i) ? "\\$" : text[i];
  return out;
}

/**
 * What the editor wrote, as the page's text: no closing line break, a break the editor marks with a backslash is a plain line
 * break again (that is what a line break means in this text), and the signs the editor protected with a backslash so they would
 * not be read as marks (`3 \* 4`, `\[1]`, a price's `\$`) are plain again: the text is read by people, not by a Markdown program.
 */
export function fromEditor(markdown: string): string {
  return markdown.replace(/\\\n/g, "\n").replace(/\\([*_[\]$])/g, "$1").replace(/\n+$/, "");
}

/** The text as the editor is given it. */
export function toEditor(text: string): string {
  return protectDollars(text);
}
