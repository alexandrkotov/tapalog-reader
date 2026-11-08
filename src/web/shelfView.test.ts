import { expect, test } from "bun:test";
import { DEFAULT_PREFS, filterBooks, formatsOf, isFiltering, NO_FILTERS, parsePrefs, sortBooks, startsReversed, type Filterable, type Sortable } from "./shelfView";

type B = Sortable & Filterable;
const book = (id: string, over: Partial<B> = {}): B => ({ id, title: id, authors: [], year: null, added: 0, ext: "pdf", tags: [], ...over });
const ids = (list: B[]) => list.map((b) => b.id);

test("books are ordered by title with numbers read as numbers", () => {
  const list = [book("Book 10"), book("book 2"), book("Atlas")];
  expect(ids(sortBooks(list, "title", false))).toEqual(["Atlas", "book 2", "Book 10"]);
  expect(ids(sortBooks(list, "title", true))).toEqual(["Book 10", "book 2", "Atlas"]);
});

test("a book without the value goes last whichever way the order runs, and equal ones go by title", () => {
  const list = [book("c", { year: 1950 }), book("a"), book("b", { year: 1930 }), book("d", { year: 1950 })];
  expect(ids(sortBooks(list, "year", false))).toEqual(["b", "c", "d", "a"]);
  expect(ids(sortBooks(list, "year", true))).toEqual(["c", "d", "b", "a"]);
  const authors = [book("x", { authors: ["Zorin"] }), book("y"), book("z", { authors: ["Abel", "Zorin"] })];
  expect(ids(sortBooks(authors, "author", false))).toEqual(["z", "x", "y"]); // by the first author
});

test("by date added and by last opened, with a book never opened last", () => {
  const list = [book("old", { added: 1 }), book("new", { added: 9 }), book("mid", { added: 5 })];
  expect(ids(sortBooks(list, "added", true))).toEqual(["new", "mid", "old"]);
  const opened = new Map([["old", 100], ["mid", 50]]);
  expect(ids(sortBooks(list, "opened", true, opened))).toEqual(["old", "mid", "new"]);
  expect(ids(sortBooks(list, "opened", false, opened))).toEqual(["mid", "old", "new"]);
  expect(startsReversed("added") && startsReversed("opened") && !startsReversed("title")).toBe(true);
});

test("sorting does not change the list it was given", () => {
  const list = [book("b"), book("a")];
  sortBooks(list, "title", false);
  expect(ids(list)).toEqual(["b", "a"]);
});

test("filters keep the books that pass all of them", () => {
  const list = [book("a", { ext: "pdf", authors: ["И. Г. Беляев"], tags: ["Радио"] }), book("b", { ext: "epub", authors: ["Беляев А."], tags: ["радио", "схемы"] }), book("c", { ext: "pdf", tags: ["схемы"] })];
  expect(ids(filterBooks(list, NO_FILTERS))).toEqual(["a", "b", "c"]);
  expect(ids(filterBooks(list, { ...NO_FILTERS, format: "pdf" }))).toEqual(["a", "c"]);
  expect(ids(filterBooks(list, { ...NO_FILTERS, tag: "радио" }))).toEqual(["a", "b"]); // whatever the letter case
  expect(ids(filterBooks(list, { ...NO_FILTERS, author: " беляев " }))).toEqual(["a", "b"]);
  expect(ids(filterBooks(list, { format: "pdf", tag: "радио", author: "беляев" }))).toEqual(["a"]);
  expect(isFiltering(NO_FILTERS)).toBe(false);
  expect(isFiltering({ ...NO_FILTERS, author: "  " })).toBe(false);
  expect(isFiltering({ ...NO_FILTERS, tag: "x" })).toBe(true);
});

test("formats present, most books first", () => {
  expect(formatsOf([book("a"), book("b", { ext: "epub" }), book("c", { ext: "epub" }), book("d", { ext: "fb2" })])).toEqual([
    { ext: "epub", count: 2 },
    { ext: "fb2", count: 1 },
    { ext: "pdf", count: 1 },
  ]);
});

test("what the browser stored is read back, and anything odd is the default", () => {
  expect(parsePrefs('{"view":"list","sort":"year","desc":true}')).toEqual({ view: "list", sort: "year", desc: true });
  expect(parsePrefs('{"view":"cube","sort":"mood","desc":1}')).toEqual(DEFAULT_PREFS);
  expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
  expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
});
