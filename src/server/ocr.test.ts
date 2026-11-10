import { expect, test } from "bun:test";
import { cleanBoxes, cleanOcrText, MAX_BOXES, MAX_PAGE_CHARS, validLang } from "./ocr";

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

test("the frames of words are kept to their shape: the corners held to the page, frames with no area and words with nothing to show dropped, and anything of another shape refused", () => {
  expect(cleanBoxes([["Лампа", 0.1, 0.2, 0.3, 0.25]])).toEqual([["Лампа", 0.1, 0.2, 0.3, 0.25]]);
  expect(cleanBoxes([["a", -0.5, 0.123456, 1.7, 0.2]])).toEqual([["a", 0, 0.1235, 1, 0.2]]); // held to the page, four decimals
  expect(cleanBoxes([["x", 0.5, 0.5, 0.5, 0.6], ["y", 0.1, 0.4, 0.2, 0.3], [" \u0001 ", 0.1, 0.1, 0.2, 0.2], ["ok", 0.1, 0.1, 0.2, 0.2]])).toEqual([["ok", 0.1, 0.1, 0.2, 0.2]]);
  expect(cleanBoxes([["a b\u0000c", 0.1, 0.1, 0.2, 0.2]])).toEqual([["abc", 0.1, 0.1, 0.2, 0.2]]); // a word has no space inside
  expect(cleanBoxes([])).toEqual([]);
  for (const bad of [null, "x", {}, [["a", 1, 2, 3]], [["a", 1, 2, 3, 4, 5]], [[1, 0, 0, 1, 1]], [["a", "0", 0, 1, 1]], [["a", 0, 0, NaN, 1]], [["a", 0, 0, Infinity, 1]], ["abcde"]]) expect(cleanBoxes(bad)).toBeNull();
  const many = Array.from({ length: MAX_BOXES + 50 }, () => ["w", 0.1, 0.1, 0.2, 0.2]);
  expect(cleanBoxes(many)).toHaveLength(MAX_BOXES); // the rest of a halftone's dots is not kept
});

test("the frames of a page's words are kept with its reading, replaced by the next one, hidden once a person writes the page, and gone with the page or the book", () => {
  const ocr = fresh();
  ocr.start("b", 3, "rus");
  const frames = (word: string): [string, number, number, number, number][] => [[word, 0.1, 0.1, 0.4, 0.15]];
  ocr.put("b", 1, "Тихий приёмник", frames("Тихий"));
  ocr.put("b", 2, "Без рамок");
  ocr.put("b", 3, "Третья", frames("Третья"));
  expect(ocr.boxes("b", 1)).toEqual(frames("Тихий"));
  expect(ocr.boxes("b", 2)).toBeNull(); // read by a recognizer that gave none
  expect(ocr.boxes("b", 9)).toBeNull();
  expect(ocr.boxes("nope", 1)).toBeNull();

  ocr.put("b", 1, "Другое чтение", frames("Другое")); // the next reading brings its own
  expect(ocr.boxes("b", 1)).toEqual(frames("Другое"));
  ocr.put("b", 1, "Чтение без рамок"); // and one without leaves none: they would belong to the old words
  expect(ocr.boxes("b", 1)).toBeNull();
  ocr.put("b", 1, "   ", frames("лишнее")); // a page with no text has no words to lay over it
  expect(ocr.boxes("b", 1)).toBeNull();
  expect(ocr.boxPages("b")).toEqual([3]); // the pages that have frames to show, in order
  ocr.put("b", 1, "Первая", frames("Первая"));
  expect(ocr.boxPages("b")).toEqual([1, 3]);
  ocr.edit("b", 1, "Первая, поправлено");
  expect(ocr.boxPages("b")).toEqual([3]); // a page written by hand shows none
  ocr.restore("b", 1);
  expect(ocr.boxPages("b")).toEqual([1, 3]); // and shows them again when it is taken back
  ocr.put("b", 1, "   ");
  expect(ocr.boxPages("nope")).toEqual([]);

  // written by hand: the words are no longer the frames', so none are shown; taking the writing back shows them again
  ocr.put("b", 3, "Третья", frames("Третья"));
  ocr.edit("b", 3, "Третья, поправлено");
  expect(ocr.boxes("b", 3)).toBeNull();
  ocr.put("b", 3, "Совсем другое", frames("Другое")); // a page written by hand is not touched by a reading, frames included
  ocr.restore("b", 3);
  expect(ocr.boxes("b", 3)).toEqual(frames("Третья"));

  // a page that was never read, written and then taken back, is unread again and has nothing
  ocr.edit("b", 2, "Написано");
  ocr.restore("b", 2);
  expect(ocr.boxes("b", 2)).toBeNull();

  ocr.remove("b");
  expect(ocr.boxes("b", 3)).toBeNull();
  ocr.start("b", 3, "rus");
  ocr.put("b", 3, "Снова", frames("Снова"));
  ocr.start("b", 4, "rus"); // another page count: another file, and none of the old frames
  expect(ocr.boxes("b", 3)).toBeNull();
});

test("pages read without frames can be taken up again: the next start does not count them as read, and a page written by hand is never one of them", () => {
  const ocr = fresh();
  ocr.start("b", 4, "rus");
  ocr.put("b", 1, "С рамками", [["С", 0.1, 0.1, 0.2, 0.2]]);
  ocr.put("b", 2, "Без рамок");
  ocr.put("b", 3, "   "); // an empty page has nothing to select
  ocr.put("b", 4, "Правленая");
  ocr.edit("b", 4, "Правленая вручную");
  expect(ocr.plainPages("b")).toEqual([2]);
  expect(ocr.progress("b")).toMatchObject({ done: 4, plain: 1 });
  expect(ocr.start("b", 4, "rus")).toEqual([1, 2, 3, 4]); // a plain start goes on as it always did
  expect(ocr.start("b", 4, "rus", true)).toEqual([1, 3, 4]); // page 2 is to be read again
  ocr.put("b", 2, "Без рамок", [["Без", 0.1, 0.1, 0.3, 0.2]]);
  expect(ocr.progress("b")).toMatchObject({ done: 4, plain: 0 });
  expect(ocr.start("b", 4, "rus", true)).toEqual([1, 2, 3, 4]); // nothing left to take up
  expect(ocr.plainPages("nope")).toEqual([]);
});

test("a page with a text of its own is kept with the book without going into the search of the readings, counts as read, is taken over by a reading, and restoring a corrected one brings the own text back", () => {
  const ocr = fresh();
  ocr.start("b", 4, "rus");
  const own = "Собственный текст страницы, набранный в самом PDF.";
  expect(ocr.putOwn("b", 1, own)).toEqual({ done: 1, pages: 4 });
  expect(ocr.pages("b")).toEqual([{ page: 1, text: own, edited: false, own: true }]);
  expect(find(ocr, "собственный")).toEqual([]); // the book's own index has it: the search must not find it twice
  expect(ocr.progress("b")).toMatchObject({ done: 1, own: 1, plain: 0, edited: 0 });
  expect(ocr.totals()).toEqual({ books: 1, pages: 0 }); // not counted among the pages that were read from pictures
  expect(ocr.start("b", 4, "rus")).toEqual([1]); // a start goes on from it
  expect(ocr.start("b", 4, "rus", true)).toEqual([1]); // and a second reading has nothing to add to it: it has no pictures' words to lack
  expect(ocr.boxes("b", 1)).toBeNull();

  // corrected: the writing is what is searched and shown; taken back, the own text is there again, still outside the readings' search
  ocr.edit("b", 1, "Поправленный текст страницы");
  expect(ocr.pages("b")).toEqual([{ page: 1, text: "Поправленный текст страницы", edited: true }]);
  expect(find(ocr, "поправленный")).toEqual(['b:{"page":1}']);
  expect(ocr.progress("b")).toMatchObject({ done: 1, own: 0, edited: 1 });
  expect(ocr.restore("b", 1)).toEqual({ page: { page: 1, text: own, edited: false, own: true } });
  expect(find(ocr, "поправленный")).toEqual([]);
  expect(ocr.pages("b")).toEqual([{ page: 1, text: own, edited: false, own: true }]);
  expect(ocr.progress("b")).toMatchObject({ own: 1, edited: 0 });

  // a reading of the picture takes the page over: it is the reader's now
  ocr.put("b", 1, "Прочитано с картинки");
  expect(ocr.pages("b")).toEqual([{ page: 1, text: "Прочитано с картинки", edited: false }]);
  expect(find(ocr, "картинки")).toEqual(['b:{"page":1}']);
  expect(ocr.progress("b")).toMatchObject({ own: 0 });
  expect(ocr.totals()).toEqual({ books: 1, pages: 1 });

  // a page written by hand is never replaced by a page's own text, and a page that is not in the book has no place for it
  ocr.edit("b", 2, "Написано вручную");
  expect(ocr.putOwn("b", 2, "Чужой текст")).toEqual({ done: 2, pages: 4 });
  expect(ocr.pages("b", 2, 2)).toEqual([{ page: 2, text: "Написано вручную", edited: true }]);
  expect(ocr.putOwn("b", 9, "x")).toBeNull();
  expect(ocr.putOwn("nope", 1, "x")).toBeNull();

  // the text of a page that had been read is replaced by the own one, and its words of frames go
  ocr.put("b", 3, "Третье чтение", [["Третье", 0.1, 0.1, 0.4, 0.2]]);
  expect(find(ocr, "третье")).toEqual(['b:{"page":3}']);
  ocr.putOwn("b", 3, "Собственный текст третьей страницы");
  expect(ocr.boxes("b", 3)).toBeNull();
  expect(find(ocr, "третье")).toEqual([]);
  expect(ocr.pages("b", 3, 3)).toEqual([{ page: 3, text: "Собственный текст третьей страницы", edited: false, own: true }]);
});

test("a database from before frames keeps its pages and gains the table for them", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE ocr_docs (id TEXT PRIMARY KEY, pages INTEGER NOT NULL, lang TEXT NOT NULL, updated INTEGER NOT NULL)");
  db.run("CREATE TABLE ocr_pages (id TEXT NOT NULL, page INTEGER NOT NULL, row INTEGER, edited INTEGER NOT NULL DEFAULT 0, orig TEXT, md TEXT, PRIMARY KEY (id, page)) WITHOUT ROWID");
  db.run("CREATE VIRTUAL TABLE ocr_chunks USING fts5(text, id UNINDEXED, loc UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')");
  db.run("INSERT INTO ocr_docs VALUES ('old', 1, 'rus', 1)");
  const row = Number(db.run("INSERT INTO ocr_chunks (text, id, loc) VALUES ('старый текст', 'old', '{\"page\":1}')").lastInsertRowid);
  db.run("INSERT INTO ocr_pages (id, page, row) VALUES ('old', 1, ?)", [row]);
  const ocr = new OcrText(db);
  expect(ocr.pages("old")).toEqual([{ page: 1, text: "старый текст", edited: false }]);
  expect(ocr.boxes("old", 1)).toBeNull(); // read before frames were kept
  ocr.put("old", 1, "новое чтение", [["новое", 0.1, 0.1, 0.2, 0.2]]);
  expect(ocr.boxes("old", 1)).toEqual([["новое", 0.1, 0.1, 0.2, 0.2]]);
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

// ----- pictures cut from the scan -----

import { imagesIn, MAX_IMAGE_BYTES, withoutImages, zipOcrText } from "./ocr";
import { unzipSync, strFromU8 } from "fflate";

const png = (extra = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40 + extra).fill(7)]);

test("the references to pictures stay out of what is searched, but the page keeps them", () => {
  const ocr = fresh();
  ocr.start("b", 3, "rus");
  ocr.put("b", 1, "Схема генератора");
  const text = "Схема усилителя\n\n![Рис. 1](images/p001-1.png)\n\nПодпись под рисунком";
  expect(ocr.edit("b", 1, text)).toMatchObject({ edited: 1 });
  expect(ocr.pages("b")).toEqual([{ page: 1, text, edited: true }]);
  expect(find(ocr, "усилителя")).toHaveLength(1);
  expect(find(ocr, "png")).toEqual([]); // nothing of the reference is in the index
  expect(find(ocr, "images")).toEqual([]);
  expect(ocr.rows("рисунком", "[", "]", undefined, 5)[0]!.snip).not.toContain("png");
  expect(ocr.restore("b", 1)).toEqual({ page: { page: 1, text: "Схема генератора", edited: false } }); // back to what was read, without the picture
  expect(ocr.pages("b")[0]!.text).toBe("Схема генератора");
  // a page of nothing but a picture is a page with text for the file and none for the index
  ocr.edit("b", 2, "![Рис.](images/p002-1.png)");
  expect(ocr.pages("b", 2, 2)).toEqual([{ page: 2, text: "![Рис.](images/p002-1.png)", edited: true }]);
  expect(ocr.progress("b")).toMatchObject({ done: 2, edited: 1 });
});

test("pictures are kept with the book, named by page, and only a PNG of a sensible size is taken", () => {
  const ocr = fresh();
  ocr.start("b", 9, "rus");
  expect(ocr.addImage("b", 8, png())).toEqual({ name: "p008-1.png", page: 8, size: png().length });
  expect(ocr.addImage("b", 8, png(1))?.name).toBe("p008-2.png");
  expect(ocr.addImage("b", 2, png())?.name).toBe("p002-1.png");
  expect(ocr.images("b").map((i) => i.name)).toEqual(["p002-1.png", "p008-1.png", "p008-2.png"]);
  expect(ocr.image("b", "p008-2.png")).toEqual(png(1));
  expect(ocr.image("b", "p009-1.png")).toBeNull();
  expect(ocr.addImage("b", 10, png())).toBeNull(); // not in the book
  expect(ocr.addImage("none", 1, png())).toBeNull(); // the book was not started
  expect(ocr.addImage("b", 1, new Uint8Array([1, 2, 3, 4, ...new Array(60).fill(0)]))).toBeNull(); // not a PNG
  expect(ocr.addImage("b", 1, new Uint8Array(MAX_IMAGE_BYTES + 1))).toBeNull();
  expect(ocr.addImage("b", 1, png()) !== null).toBe(true);
  ocr.removeImage("b", "p008-1.png");
  expect(ocr.addImage("b", 8, png())?.name).toBe("p008-3.png"); // a number is not used again while a later one exists
});

test("deleting a picture takes its references out of the pages; forgetting a book deletes its pictures", () => {
  const ocr = fresh();
  ocr.start("b", 3, "rus");
  ocr.addImage("b", 1, png());
  ocr.addImage("b", 1, png(1));
  ocr.edit("b", 1, "До\n\n![А](images/p001-1.png)\n\nпосле ![Б](images/p001-2.png) конец");
  ocr.edit("b", 2, "Вторая ссылается на ту же: ![А](images/p001-1.png)");
  expect(ocr.progress("b")).toMatchObject({ images: 2 }); // what the Forget question counts
  expect(ocr.removeImage("b", "p001-1.png")).toEqual([
    { page: 1, text: "До\n\nпосле ![Б](images/p001-2.png) конец", edited: true },
    { page: 2, text: "Вторая ссылается на ту же:", edited: true },
  ]);
  expect(ocr.images("b").map((i) => i.name)).toEqual(["p001-2.png"]);
  expect(ocr.removeImage("b", "p001-1.png")).toBeNull();
  expect(find(ocr, "ссылается")).toHaveLength(1); // the index follows the page
  expect(ocr.remove("b")).toBe(2);
  expect(ocr.images("b")).toEqual([]);
  expect(ocr.image("b", "p001-2.png")).toBeNull();
});

test("a database from before pictures keeps its pages and gains the column for them", () => {
  const db = new Database(":memory:");
  const first = new OcrText(db);
  first.start("b", 1, "rus");
  first.edit("b", 1, "правка");
  db.run("ALTER TABLE ocr_pages DROP COLUMN md");
  const ocr = new OcrText(db);
  expect(ocr.pages("b")).toEqual([{ page: 1, text: "правка", edited: true }]);
  expect(ocr.edit("b", 1, "![x](images/p001-1.png)")).toMatchObject({ edited: 1 });
});

test("the names of the pictures a text refers to are all found, whatever was searched before", () => {
  const ocr = fresh();
  ocr.start("b", 2, "rus");
  const text = "![А](images/p001-1.png)\n\n![Б](images/p001-2.png)";
  ocr.edit("b", 1, text); // looks for references in the text just as a later search does
  ocr.edit("b", 2, text);
  expect(imagesIn(text)).toEqual(["p001-1.png", "p001-2.png"]);
  expect(imagesIn(text)).toEqual(["p001-1.png", "p001-2.png"]);
});

test("the book as a file leaves the pictures out of plain text and puts them into a zip beside the Markdown", () => {
  const pages = [
    { page: 1, text: "Текст.\n\n![Рис. 1](images/p001-1.png)\n\nПодпись.", edited: true },
    { page: 2, text: "![Рис. 2](images/p002-1.png)", edited: true },
  ];
  const md = renderOcrText({ title: "Книга", pages, total: 2, done: 2, format: "md", lang: "ru" });
  expect(md).toContain("![Рис. 1](images/p001-1.png)");
  const txt = renderOcrText({ title: "Книга", pages, total: 2, done: 2, format: "txt", lang: "ru" });
  expect(txt).toBe("Книга\n\n[Страница 1]\n\nТекст.\n\nПодпись.\n"); // the page of a picture alone has nothing to say in plain text
  expect(imagesIn(md)).toEqual(["p001-1.png", "p002-1.png"]);
  expect(withoutImages("a ![x](images/p001-1.png) b ![y](https://example.com/z.png)")).toBe("a  b ![y](https://example.com/z.png)"); // only the book's own pictures
  const files = unzipSync(zipOcrText(md, [{ name: "p001-1.png", data: png() }, { name: "p002-1.png", data: png(1) }, { name: "p009-1.png", data: png(2) }]));
  expect(Object.keys(files).sort()).toEqual(["book.md", "images/p001-1.png", "images/p002-1.png"]); // a picture nothing refers to is not shipped
  expect(strFromU8(files["book.md"]!)).toBe(md);
  expect(files["images/p002-1.png"]).toEqual(png(1));
});
