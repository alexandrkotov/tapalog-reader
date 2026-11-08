/** What the shelf needs to know about tags: counting them, choosing books by them, and the address that holds a choice. */

export interface TagInfo {
  /** Lower-cased: "Radio" and "radio" are one tag. */
  key: string;
  /** How it is written: the spelling most books use. */
  label: string;
  count: number;
}

/** Every tag in use, most books first, then by name. */
export function countTags(books: { tags: string[] }[]): TagInfo[] {
  const found = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const book of books) {
    const seen = new Set<string>(); // a book counts once for a tag
    for (const tag of book.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = found.get(key) ?? { spellings: new Map(), count: 0 };
      entry.count++;
      entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1);
      found.set(key, entry);
    }
  }
  return [...found].map(([key, { spellings, count }]) => ({ key, count, label: [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0] })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The books that have every one of the tags. */
export function withAllTags<T extends { tags: string[] }>(books: T[], keys: string[]): T[] {
  if (!keys.length) return books;
  return books.filter((book) => {
    const have = new Set(book.tags.map((tag) => tag.toLowerCase()));
    return keys.every((key) => have.has(key));
  });
}

/** The tags a `#tags=a,b` address names. */
export function parseTags(param: string | null): string[] {
  const keys = (param ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(keys)];
}

/** The address that shows the books with all of these tags (the top shelf when there are none). */
export const tagsHash = (keys: string[]): string => (keys.length ? `#tags=${keys.map(encodeURIComponent).join(",")}` : "#");

/** The choice after the reader clicked a tag: it is added, or taken out when it was chosen. */
export const toggleTag = (keys: string[], key: string): string[] => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
