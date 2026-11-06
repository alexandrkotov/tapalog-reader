/**
 * The page numbers printed in a book are not the page numbers of its file: the cover and the front matter come
 * first. The reader gives the difference once (`offset` = pages of the file before printed page 1), and these
 * functions translate. Everything that is stored keeps the file's page numbers; only what is shown and typed
 * is printed numbers.
 */

/** The printed number of a file page, or null for a page before printed page 1 (the front matter has no number here). */
export function printedOf(filePage: number, offset: number): number | null {
  const printed = filePage - offset;
  return printed >= 1 ? printed : null;
}

/** The file page that carries a printed number. */
export const fileOf = (printed: number, offset: number): number => printed + offset;

/** The offset that makes file page `filePage` carry the printed number `printed` (both whole, printed at least 1). */
export const offsetFor = (filePage: number, printed: number): number => filePage - printed;
