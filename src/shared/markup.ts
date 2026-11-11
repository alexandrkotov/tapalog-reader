/**
 * The Markdown that a page's text may hold, read the way the visual editor reads it: **bold**, *italic* (or _italic_), `code`,
 * headings, lists, quotes, and formulas in dollars. The program's page (to set a PDF), the server (to index and to write plain text)
 * and the editor share these rules, so that all of them see one text. Nothing here touches a page.
 */

const SPACE = /\s/;

/**
 * The dollar signs of a line, as pandoc reads them: a `$` opens a formula when no space follows it, and closes one when no space
 * comes before it and no digit after it; an opening one that meets another opening one before any end is a price, not a formula.
 * `formulas` are the [start, end) ranges of the formulas with their dollars, `prices` the places of the dollars that are no formulas
 * (a `$$` and one escaped with a backslash are neither).
 */
export function scanDollars(text: string): { formulas: [number, number][]; prices: number[] } {
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
  const formulas: [number, number][] = [];
  const prices: number[] = [];
  for (let k = 0; k < marks.length; k++) {
    const open = marks[k]!;
    const next = text[open + 1];
    if (next === undefined || SPACE.test(next)) {
      prices.push(open);
      continue;
    }
    let close = -1;
    for (let j = k + 1; j < marks.length; j++) {
      const at = marks[j]!;
      const before = text[at - 1];
      const after = text[at + 1];
      if (before !== undefined && !SPACE.test(before) && !(after !== undefined && /\d/.test(after))) {
        close = j;
        break;
      }
      // a dollar that opens a formula of its own (a space before, none after): the one before it had no end
      if ((before === undefined || SPACE.test(before)) && after !== undefined && !SPACE.test(after)) break;
    }
    if (close < 0) prices.push(open);
    else {
      formulas.push([open, marks[close]! + 1]);
      k = close;
    }
  }
  return { formulas, prices };
}

/** A piece of a line with one look: plain, bold, italic, or a formula (its LaTeX, with no dollars). */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  formula?: boolean;
}

const unescape = (text: string) => text.replace(/\\([\\`*_{}[\]()#+\-.!$|<>~])/g, "$1");

/** Marks inside a stretch with no formulas: `**bold**`, `*italic*`, `_italic_`, `` `code` `` (shown plain). */
function marked(text: string, base: { bold?: boolean; italic?: boolean }): Run[] {
  const out: Run[] = [];
  const add = (piece: string, look: { bold?: boolean; italic?: boolean }) => {
    if (piece) out.push({ text: piece, ...(look.bold ? { bold: true } : {}), ...(look.italic ? { italic: true } : {}) });
  };
  // the first mark found is taken, and what is inside it read again (bold in italics and the other way round)
  const mark = /(?<!\\)(?:\*\*(?=\S)([^\n]*?\S)\*\*|(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|`([^`\n]+)`)/g;
  let from = 0;
  for (const m of text.matchAll(mark)) {
    add(unescape(text.slice(from, m.index)), base);
    if (m[1] !== undefined) out.push(...marked(m[1], { ...base, bold: true }));
    else if (m[2] !== undefined || m[3] !== undefined) out.push(...marked((m[2] ?? m[3])!, { ...base, italic: true }));
    else add(m[4]!, base);
    from = m.index + m[0].length;
  }
  add(unescape(text.slice(from)), base);
  return out;
}

/** One line of text as runs; adjacent runs with the same look are joined. */
export function inlineRuns(line: string, base: { bold?: boolean; italic?: boolean } = {}): Run[] {
  const runs: Run[] = [];
  let from = 0;
  for (const [start, end] of scanDollars(line).formulas) {
    runs.push(...marked(line.slice(from, start), base));
    runs.push({ text: line.slice(start + 1, end - 1), formula: true });
    from = end;
  }
  runs.push(...marked(line.slice(from), base));
  const joined: Run[] = [];
  for (const run of runs) {
    const last = joined[joined.length - 1];
    if (last && !last.formula && !run.formula && !!last.bold === !!run.bold && !!last.italic === !!run.italic) last.text += run.text;
    else joined.push({ ...run });
  }
  return joined;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;

/** Block formulas `$$ … $$` of a text, with the ranges they take (they may stretch over lines). */
function blockFormulas(text: string): { start: number; end: number; latex: string }[] {
  return [...text.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, latex: m[1]!.trim() }));
}

/**
 * The text of a page as plain words, for what is read by eye or by a search: no marks of bold, italic and code, no `#` before a
 * heading, no `>` before a quote. Formulas are dropped for a search (their LaTeX is no words) and written as their LaTeX
 * (without the dollars) for a text file. List signs stay, as in any plain text.
 */
export function plainText(text: string, formulas: "drop" | "keep"): string {
  let out = "";
  let from = 0;
  for (const block of blockFormulas(text)) {
    out += plainLines(text.slice(from, block.start), formulas);
    out += formulas === "keep" ? block.latex : "";
    from = block.end;
  }
  out += plainLines(text.slice(from), formulas);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function plainLines(text: string, formulas: "drop" | "keep"): string {
  return text
    .split("\n")
    .map((raw) => {
      const heading = HEADING.exec(raw);
      const line = heading ? heading[2]! : raw.replace(QUOTE, "");
      const words = inlineRuns(line)
        .filter((run) => !run.formula || formulas === "keep")
        .map((run) => run.text)
        .join("");
      return words;
    })
    .join("\n");
}

export { HEADING, QUOTE };
