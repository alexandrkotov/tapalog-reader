/**
 * The text a PDF page already has in the file. A book of mixed pages (some typeset, some scanned) is read only where it has to
 * be: a page with enough text of its own is taken as it is, and only the pages without are read from their pictures.
 */

/** A page with fewer letters than this is taken for a picture with a number or a stamp on it, and is read. */
export const OWN_MIN_CHARS = 25;

/** The pieces of text pdf.js finds on a page (the same as the server's indexer reads, so the two agree on what a page says). */
export interface TextPiece {
  str?: string;
  hasEOL?: boolean;
}

/** The page's own text, or null when it has too little to be taken in place of reading the picture. */
export function ownText(items: readonly TextPiece[], minChars = OWN_MIN_CHARS): string | null {
  const text = items
    .map((i) => (typeof i.str === "string" ? i.str + (i.hasEOL ? "\n" : " ") : ""))
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
  return text.replace(/\s/g, "").length >= minChars ? text : null;
}
