import { expect, test } from "bun:test";
import { filterRows, isUnread, sortRows, stateOf, wordsOf, type OcrListRow } from "./ocrList";

const row = (id: string, title: string, path: string, size: number, pages: number | null = null, done = 0): OcrListRow => ({ id, title, path, size, pages, done });

const rows = [
  row("a", "Механизмы, 1965", "Учебники/Кожевников Механизмы 1965.pdf", 46, 1062, 1062),
  row("b", "Летающие крылья", "Авиамоделизм/Костенко Летающие крылья.pdf", 9),
  row("c", "Авиамодели 10", "Авиамоделизм/Авиамодели 10.pdf", 70, 200, 80),
  row("d", "Авиамодели 2", "Авиамоделизм/Авиамодели 2.pdf", 20),
  row("e", "Справочник токаря", "Учебники/Мукин Справочник токаря.pdf", 6, 449, 0),
];

test("a book is new until a page has been read, half done until the last, then done", () => {
  expect(rows.map(stateOf)).toEqual(["done", "new", "partial", "new", "new"]);
  expect(rows.filter(isUnread).map((r) => r.id)).toEqual(["b", "c", "d", "e"]);
});

test("the words of a query are lower case and the empty ones are dropped", () => {
  expect(wordsOf("  Авиа  МОДЕЛИ ")).toEqual(["авиа", "модели"]);
  expect(wordsOf("   ")).toEqual([]);
});

test("filtering: every word must be in the title or the path, and the state must fit", () => {
  const ids = (query: string, show: Parameters<typeof filterRows>[2] = "all") => filterRows(rows, query, show).map((r) => r.id);
  expect(ids("")).toEqual(["a", "b", "c", "d", "e"]);
  expect(ids("авиамоделизм")).toEqual(["b", "c", "d"]); // a folder, found by the path
  expect(ids("крылья АВИАМОД")).toEqual(["b"]); // both words, any case, any order
  expect(ids("токаря 1965")).toEqual([]);
  expect(ids("", "unread")).toEqual(["b", "c", "d", "e"]);
  expect(ids("", "partial")).toEqual(["c"]);
  expect(ids("", "done")).toEqual(["a"]);
  expect(ids("авиамоделизм", "unread")).toEqual(["b", "c", "d"]);
  expect(ids("учебники", "partial")).toEqual([]);
});

test("sorting: by path, by title (numbers by value), the unrecognized first, the biggest first; the input is left alone", () => {
  const ids = (sort: Parameters<typeof sortRows>[1]) => sortRows(rows, sort).map((r) => r.id);
  expect(ids("path")).toEqual(["d", "c", "b", "a", "e"]); // "… 2" before "… 10"
  expect(sortRows(rows, "title").map((r) => r.title)).toEqual(["Авиамодели 2", "Авиамодели 10", "Летающие крылья", "Механизмы, 1965", "Справочник токаря"]);
  expect(ids("unread")).toEqual(["d", "b", "e", "c", "a"]); // new ones by path, then the half done, then the done
  expect(ids("size")).toEqual(["c", "a", "d", "b", "e"]);
  expect(ids("pages")).toEqual(["a", "e", "c", "d", "b"]); // 1062, 449, 200 pages, then the ones whose pages are not known, by path
  expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
});
