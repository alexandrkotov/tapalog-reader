/**
 * The words of a search that are marked on the page of a book it leads to. No DOM here, so they are tested alone.
 */

/** The words an index marks in a snippet (between \u0001 and \u0002): the forms found in the text, each once, in the order they come. */
export function markedWords(snippet: string): string[] {
  const words: string[] = [];
  snippet.split("\u0001").slice(1).forEach((part) => {
    const word = part.split("\u0002")[0]!.trim();
    if (word && !words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
  });
  return words;
}

/** The words as they are written in an address (`find=…`, separated by spaces), at most a few and none of them long. */
export function findParam(words: string[]): string {
  return words.slice(0, 8).map((w) => w.slice(0, 60)).join(" ");
}

/** Reads `findParam` back. */
export const wordsOf = (param: string | null | undefined): string[] => (param ?? "").split(/\s+/).filter(Boolean).slice(0, 8).map((w) => w.slice(0, 60));

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern that finds any of the words as whole words in any case (letters of every alphabet), or null when there is none. */
export function termPattern(words: string[]): RegExp | null {
  const clean = [...new Set(words.map((w) => w.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!clean.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${clean.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");
}
