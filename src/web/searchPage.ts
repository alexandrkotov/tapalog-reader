import { t } from "./i18n";
import { shelfBarEl } from "./shelfBar";
import { DEFAULT_PREFS, type Filters } from "./shelfView";
import { filterParams, placeHash } from "./searchAddress";
import type { TagInfo } from "./tags";
import { badge, el } from "./ui";

/** What the page needs to know of a book: the server's list entries carry all of it. */
export interface FoundBook {
  id: string;
  title: string;
  authors: string[];
  path: string;
  ext: string;
}

interface Place {
  snippet: string;
  view: unknown;
  loc: Record<string, number>;
  /** How far into a text file the words are (0 to 1). */
  share?: number;
}
interface Progress {
  enabled: boolean;
  /** Books settled: read, or with nothing to read. */
  done: number;
  total: number;
}
interface ContentBook extends FoundBook {
  hits: Place[];
  more: boolean;
}

export interface SearchPageSpec {
  query: string;
  filters: Filters;
  /** The formats and tags of the whole library: what the filters offer. */
  formats: { ext: string; count: number }[];
  tags: TagInfo[];
  /** A book found by its name, as a line of a list. */
  nameRow(book: FoundBook): HTMLElement;
  /** A snippet of text with the found words marked. */
  snippet(text: string): HTMLElement;
  /** The address now says this query and these filters (without leaving the page). */
  remember(query: string, filters: Filters): void;
  /** Search inside the books is on; false: the page says so instead. */
  fullText: boolean;
  isAdmin: boolean;
}

/** "Page 12", "Section 3", "40% of the book": where in the book the words are, or "" when the format has no such notion. */
export function placeLabel(loc: Record<string, number>, share?: number): string {
  if (typeof loc.page === "number") return t("search.at.page", { n: loc.page });
  if (typeof loc.section === "number") return t("search.at.section", { n: loc.section + 1 });
  if (typeof loc.fraction === "number") return t("search.at.fraction", { n: Math.round(loc.fraction * 100) });
  if (typeof share === "number") return t("search.at.fraction", { n: Math.floor(share * 100) });
  return "";
}

const NAME_LIMIT = 300;
const PLACES_PER_BOOK = 5;
const ALL_PLACES = 100;
const BOOKS_SHOWN = 60;
const STATE_EVERY = 4000;

/**
 * The page of search results: books found by name, title, author or tag, and, when the index is on, the books that
 * contain the words, each with a few places (page or section, and the text around the words) and a way to see
 * all of its places. Filters narrow both lists. The quick list under the search box is still there for a jump.
 */
export function searchPageEl(spec: SearchPageSpec): HTMLElement {
  let filters = { ...spec.filters };
  let turn = 0; // a slow answer to an older question must not replace a newer one
  const names = el("section", { class: "found-names" });
  const content = el("section", { class: "found-content" });
  const nothing = el("p", { class: "shelf-empty", hidden: true, textContent: t("search.none", { q: spec.query }) });
  // while the books are still being read the results may lack some of them: say so, and offer to ask again once more are read
  const indexing = el("p", { class: "found-indexing", hidden: true });
  const again = el("button", { type: "button", class: "btn found-again", hidden: true, textContent: t("search.again") });
  const banner = el("div", { class: "found-banner", hidden: true }, indexing, again);
  let askedAt = 0; // how many books were read when the question was last asked
  const showState = (p: Progress) => {
    const working = p.enabled && p.done < p.total;
    const fresher = p.enabled && p.done > askedAt; // books were read since the question was asked: asking again may find more
    banner.hidden = !working && !fresher;
    indexing.textContent = working ? t("search.indexing", { done: p.done, total: p.total }) : t("search.indexed");
    again.hidden = !fresher;
  };
  again.addEventListener("click", () => void run());
  const watch = setInterval(async () => {
    if (!root.isConnected) return clearInterval(watch);
    if (!spec.fullText || banner.hidden) return;
    const p = await get<Progress>("/api/fulltext/state", turn);
    if (p) showState(p);
  }, STATE_EVERY);

  const get = async <T>(path: string, mine: number): Promise<T | null> => {
    try {
      const res = await fetch(path);
      return res.ok && mine === turn ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };

  const drawNames = (books: FoundBook[]) => {
    names.replaceChildren(
      ...(books.length ? [el("h3", { class: "found-title", textContent: t("search.byName", { n: books.length }) }), el("div", { class: "shelf list" }, ...books.map((b) => spec.nameRow(b)))] : []),
    );
  };

  const drawBook = (book: ContentBook): HTMLElement => {
    const places = el("ul", { class: "found-places" });
    const more = el("button", { type: "button", class: "btn found-more", textContent: t("search.morePlaces") });
    const fill = (list: Place[]) =>
      places.replaceChildren(
        ...list.map((hit) => {
          const label = placeLabel(hit.loc, hit.share);
          return el("li", {}, el("a", { class: "found-hit", href: placeHash(book.id, hit.view) }, ...(label ? [el("span", { class: "found-where", textContent: label })] : []), spec.snippet(hit.snippet)));
        }),
      );
    fill(book.hits);
    more.hidden = !book.more;
    more.addEventListener("click", async () => {
      more.disabled = true;
      const mine = turn;
      const all = await get<{ books: ContentBook[] }>(`/api/fulltext?q=${encodeURIComponent(spec.query)}&book=${encodeURIComponent(book.id)}&per=${ALL_PLACES}`, mine);
      const found = all?.books[0];
      if (found) {
        fill(found.hits);
        more.hidden = true;
      } else more.disabled = false;
    });
    return el(
      "div",
      { class: "found-book" },
      el("a", { class: "found-head", href: `#book=${book.id}`, title: book.path }, badge(book.ext), el("span", { class: "found-name", textContent: book.title }), el("span", { class: "muted small found-path", textContent: book.authors.length ? book.authors.join(", ") : book.path })),
      places,
      more,
    );
  };

  const run = async () => {
    const mine = ++turn;
    nothing.hidden = true;
    names.replaceChildren();
    content.replaceChildren(...(spec.fullText ? [el("p", { class: "muted", textContent: t("search.searching") })] : [el("p", { class: "muted", textContent: t(spec.isAdmin ? "search.offAdmin" : "search.off") })]));
    const q = encodeURIComponent(spec.query);
    const extra = filterParams(filters);
    const byName = await get<{ books: FoundBook[] }>(`/api/search?q=${q}&limit=${NAME_LIMIT}${extra}`, mine);
    if (!byName) return;
    drawNames(byName.books);
    if (!spec.fullText) {
      nothing.hidden = byName.books.length > 0;
      return;
    }
    const inside = await get<{ enabled: boolean; books: ContentBook[]; progress: Progress }>(`/api/fulltext?q=${q}&per=${PLACES_PER_BOOK}&limit=${BOOKS_SHOWN}${extra}`, mine);
    if (!inside) return;
    askedAt = inside.progress.done;
    showState(inside.progress);
    content.replaceChildren(
      ...(inside.books.length ? [el("h3", { class: "found-title", textContent: t("search.inBooks", { n: inside.books.length }) }), ...inside.books.map(drawBook)] : []),
    );
    nothing.hidden = byName.books.length > 0 || inside.books.length > 0;
  };

  const bar = shelfBarEl({
    prefs: DEFAULT_PREFS,
    filters,
    formats: spec.formats,
    tags: spec.tags,
    filtersOnly: true,
    onPrefs: () => {},
    onFilters: (next) => {
      filters = next;
      spec.remember(spec.query, filters);
      void run();
    },
  });
  void run();
  const root = el("div", { class: "search-page" }, bar.node, banner, names, content, nothing);
  return root;
}
