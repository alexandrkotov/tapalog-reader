import { expect, test } from "bun:test";
import { cleanOcrText, MAX_PAGE_CHARS, validLang } from "./ocr";

test("a word split by a hyphen at the end of a line is joined, and the lines of a paragraph run on", () => {
  expect(cleanOcrText("Основные параметры этих термосопротивлений при-\nведены в табл. 10-4.\nНовая строка.")).toBe("Основные параметры этих термосопротивлений приведены в табл. 10-4. Новая строка.");
  expect(cleanOcrText("Тире — не перенос -\nСтрока с большой буквы")).toBe("Тире — не перенос - Строка с большой буквы"); // a hyphen before a capital stays
  expect(cleanOcrText("First paragraph.\n\n\n\nSecond one.")).toBe("First paragraph.\n\nSecond one.");
});

test("what would break the snippets or fill the index is taken out", () => {
  expect(cleanOcrText("a\u0001b\u0002c\u0000d")).toBe("a b c d"); // the marks of a found word are never in a page's text
  expect(cleanOcrText("  \r\n \t ")).toBe("");
  expect(cleanOcrText("x".repeat(MAX_PAGE_CHARS + 5)).length).toBe(MAX_PAGE_CHARS);
});

test("only the languages the engine ships with are accepted", () => {
  expect(validLang("rus")).toBe(true);
  expect(validLang("rus+eng")).toBe(true);
  expect(validLang("deu")).toBe(false);
  expect(validLang(undefined)).toBe(false);
});

// ----- the text a person writes, taking it back, and the book as a file -----

import { Database } from "bun:sqlite";
import { cleanEditedText, OcrText, renderOcrText } from "./ocr";

const fresh = () => new OcrText(new Database(":memory:"));
const find = (ocr: OcrText, word: string) => ocr.rows(word, "[", "]", undefined, 10).map((r) => `${r.id}:${r.loc}`);

test("text a person typed keeps its lines and paragraphs, and loses only what would break the index", () => {
  expect(cleanEditedText("Первая строка\nВторая строка\n\n\n\nНовый абзац  \r\nконец")).toBe("Первая строка\nВторая строка\n\nНовый абзац\nконец");
  expect(cleanEditedText("a\u0001b\u0002c")).toBe("a b c");
  expect(cleanEditedText("x".repeat(MAX_PAGE_CHARS + 3)).length).toBe(MAX_PAGE_CHARS);
});

test("a corrected page is searched by what was written, the recognizer no longer replaces it, and restoring brings back what was read", () => {
  const db = new Database(":memory:");
  const ocr = new OcrText(db);
  ocr.start("b", 3, "rus");
  ocr.put("b", 1, "Тихий радиоприёмник");
  expect(find(ocr, "радиоприёмник")).toEqual(['b:{"page":1}']);

  expect(ocr.edit("b", 1, "Тихий радиоприемник\nс лампами")).toEqual({ done: 1, pages: 3, edited: 1 });
  expect(ocr.pages("b")).toEqual([{ page: 1, text: "Тихий радиоприемник\nс лампами", edited: true }]);
  expect(find(ocr, "лампами")).toEqual(['b:{"page":1}']);
  expect(ocr.progress("b")).toMatchObject({ done: 1, edited: 1 });

  ocr.put("b", 1, "Совсем другое чтение"); // a second reading does not touch a page written by hand
  expect(ocr.pages("b")[0]!.text).toBe("Тихий радиоприемник\nс лампами");
  expect(find(ocr, "другое")).toEqual([]);

  ocr.edit("b", 1, "Ещё раз поправлено"); // the second correction keeps the very first reading
  expect(ocr.restore("b", 1)).toEqual({ page: { page: 1, text: "Тихий радиоприёмник", edited: false } });
  expect(find(ocr, "поправлено")).toEqual([]);
  expect(find(ocr, "радиоприёмник")).toEqual(['b:{"page":1}']);
  expect(ocr.progress("b")).toMatchObject({ done: 1, edited: 0 });
  expect(ocr.restore("b", 1)).toBeNull(); // nothing left to undo

  ocr.put("b", 1, "Новое чтение"); // and the page is the recognizer's again
  expect(ocr.pages("b")[0]!.text).toBe("Новое чтение");
});

test("a page that was never read can be written, counts as done, and becomes unread again when restored", () => {
  const db = new Database(":memory:");
  const ocr = new OcrText(db);
  ocr.start("b", 2, "rus");
  expect(ocr.edit("b", 2, "Написано вручную")).toEqual({ done: 1, pages: 2, edited: 1 });
  expect(ocr.start("b", 2, "rus")).toEqual([2]); // the reading skips it
  expect(ocr.restore("b", 2)).toEqual({ page: null });
  expect(ocr.pages("b")).toEqual([]);
  expect(ocr.progress("b")).toMatchObject({ done: 0, edited: 0 });
  expect(find(ocr, "вручную")).toEqual([]);
  // pages outside the book, a book that was not started, and an emptied page
  expect(ocr.edit("b", 3, "x")).toBeNull();
  expect(ocr.edit("none", 1, "x")).toBeNull();
  expect(ocr.edit("b", 1, "   ")).toEqual({ done: 1, pages: 2, edited: 1 }); // erasing a page is a correction too
  expect(ocr.pages("b")).toEqual([{ page: 1, text: "", edited: true }]);
  expect(ocr.restore("b", 1)).toEqual({ page: null });
});

test("pages come back in a range, in order", () => {
  const ocr = fresh();
  ocr.start("b", 5, "rus");
  for (const p of [4, 2, 5, 1]) ocr.put("b", p, `страница ${p}`);
  expect(ocr.pages("b").map((p) => p.page)).toEqual([1, 2, 4, 5]);
  expect(ocr.pages("b", 2, 4).map((p) => p.text)).toEqual(["страница 2", "страница 4"]);
});

test("a database made before pages could be written is brought up to date and keeps its text", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE ocr_docs (id TEXT PRIMARY KEY, pages INTEGER NOT NULL, lang TEXT NOT NULL, updated INTEGER NOT NULL)");
  db.run("CREATE TABLE ocr_pages (id TEXT NOT NULL, page INTEGER NOT NULL, row INTEGER, PRIMARY KEY (id, page)) WITHOUT ROWID");
  db.run("CREATE VIRTUAL TABLE ocr_chunks USING fts5(text, id UNINDEXED, loc UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')");
  db.run("INSERT INTO ocr_docs VALUES ('old', 2, 'rus', 1)");
  const row = Number(db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES ('старый текст', 'old', '{\"page\":1}')").lastInsertRowid);
  db.run("INSERT INTO ocr_pages (id, page, row) VALUES ('old', 1, ?)", [row]);
  const ocr = new OcrText(db);
  expect(ocr.pages("old")).toEqual([{ page: 1, text: "старый текст", edited: false }]);
  expect(ocr.progress("old")).toMatchObject({ done: 1, edited: 0 });
  expect(ocr.edit("old", 1, "новый текст")?.edited).toBe(1);
});

test("the book as a file: a heading or a bracket per page, pages without text left out, and a note when it is not whole", () => {
  const pages = [
    { page: 1, text: "Первая страница.", edited: false },
    { page: 2, text: "", edited: false },
    { page: 4, text: "Четвёртая\nстрока.", edited: true },
  ];
  expect(renderOcrText({ title: "Книга", pages, total: 4, done: 3, format: "md", lang: "ru" })).toBe("# Книга\n\n> Распознано страниц: 3 из 4.\n\n## Страница 1\n\nПервая страница.\n\n## Страница 4\n\nЧетвёртая\nстрока.\n");
  expect(renderOcrText({ title: "Книга", pages, total: 4, done: 3, format: "txt", lang: "uk" })).toBe("Книга\n\nРозпізнано сторінок: 3 із 4.\n\n[Сторінка 1]\n\nПервая страница.\n\n[Сторінка 4]\n\nЧетвёртая\nстрока.\n");
  const whole = renderOcrText({ title: "Book", pages: [{ page: 1, text: "Text.", edited: false }], total: 1, done: 1, format: "md" });
  expect(whole).toBe("# Book\n\n## Page 1\n\nText.\n"); // English by default, and no note for a whole book
});
