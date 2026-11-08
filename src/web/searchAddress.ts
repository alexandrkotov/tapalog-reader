import type { Filters } from "./shelfView";

/** The addresses of the page of search results and of a place in a book: no DOM here, so they are tested alone. */

/** `#book=…&view=…`: the book opened at that place. */
export const placeHash = (id: string, view: unknown) => `#book=${id}${view ? `&view=${encodeURIComponent(JSON.stringify(view))}` : ""}`;

/** The address of a search: the words and the filters that are on. */
export function searchHash(query: string, filters: Filters): string {
  const params = new URLSearchParams({ search: query });
  if (filters.format) params.set("format", filters.format);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author.trim()) params.set("author", filters.author.trim());
  return `#${params}`;
}

/** The query string the server's search routes take for these filters. */
export const filterParams = (filters: Filters): string => {
  const params = new URLSearchParams();
  if (filters.format) params.set("format", filters.format);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author.trim()) params.set("author", filters.author.trim());
  const text = params.toString();
  return text ? `&${text}` : "";
};
