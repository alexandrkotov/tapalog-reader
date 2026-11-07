import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { Backup, parseBackup } from "./backup";
import { applyEdit, BookMeta, cleanManual, effective, extractMeta, MAX_TAGS, MAX_TITLE, MetaError, parseFb2, parseOpf, shelfFields } from "./bookmeta";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { Library } from "./library";
import { removeDir } from "./testutil";

const base = mkdtempSync(join(tmpdir(), "reader-meta-"));
const dbs: ReturnType<typeof openDb>[] = [];
const libraries: Library[] = [];
afterAll(() => {
  for (const l of libraries) l.close();
  for (const db of dbs) db.close();
  removeDir(base);
});
let n = 0;
function install() {
  const dir = join(base, String(n++));
  const lib = join(dir, "lib");
  const data = join(dir, "data");
  mkdirSync(lib, { recursive: true });
  mkdirSync(data, { recursive: true });
  const db = openDb(data);
  dbs.push(db);
  const config = new ConfigStore(data);
  const library = new Library(db, config, data);
  libraries.push(library);
  return { dir, lib, data, db, config, library };
}

const failure = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    if (err instanceof MetaError) return err.message;
    throw err;
  }
  return "";
};

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Радиоприёмники &amp; усилители</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Беляев, И.Г.">И. Г. Беляев</dc:creator>
    <dc:creator opf:role="aut">В. Петров</dc:creator>
    <dc:creator opf:role="trl">Переводчик Иванов</dc:creator>
    <dc:date opf:event="publication">1949-05-01T00:00:00+00:00</dc:date>
    <dc:language>ru</dc:language>
    <dc:description>&lt;p&gt;Как сделать &lt;b&gt;детекторный&lt;/b&gt; приёмник.&lt;/p&gt;&lt;p&gt;Вторая строка.&lt;/p&gt;</dc:description>
    <meta name="calibre:series" content="Массовая радиобиблиотека"/>
  </metadata>
</package>`;

const epub = (opf: string, extra: Record<string, Uint8Array> = {}) =>
  zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/ch1.xhtml": strToU8("<html><body><p>Text</p></body></html>"),
    ...extra,
  });

/** The windows-1251 bytes of a Russian text, as the FB2 files of the Russian-speaking world have it. */
const cp1251 = (s: string) => Uint8Array.from([...s].map((c) => (c.charCodeAt(0) >= 0x410 && c.charCodeAt(0) <= 0x44f ? c.charCodeAt(0) - 0x350 : c === "ё" ? 0xb8 : c.charCodeAt(0))));

test("the title, authors, year, language, series and description are read from an EPUB's package file, translators left out", () => {
  expect(parseOpf(OPF)).toEqual({
    title: "Радиоприёмники & усилители",
    authors: ["И. Г. Беляев", "В. Петров"],
    year: 1949,
    language: "ru",
    series: "Массовая радиобиблиотека",
    description: "Как сделать детекторный приёмник.\nВторая строка.",
  });
  // EPUB 3 names the series as a collection, an empty package says nothing, a CDATA description is text
  expect(parseOpf(`<metadata><dc:title>T</dc:title><meta property="belongs-to-collection" id="c1">Моя серия</meta><dc:description><![CDATA[Plain <b>words</b>]]></dc:description></metadata>`)).toEqual({ title: "T", series: "Моя серия", description: "Plain words" });
  expect(parseOpf("<metadata></metadata>")).toEqual({});
});

test("the title-info of an FB2 gives the same fields, with the author's name in reading order", () => {
  const xml = `<FictionBook><description><title-info>
    <genre>sf</genre>
    <author><first-name>Аркадий</first-name><middle-name>Натанович</middle-name><last-name>Стругацкий</last-name></author>
    <author><nickname>Сидоров</nickname></author>
    <book-title>Понедельник начинается в субботу</book-title>
    <annotation><p>Сказка для научных работников.</p><empty-line/><p>Вторая.</p></annotation>
    <date value="1965-01-01">1965</date><lang>ru</lang>
    <sequence name="Сказки" number="1"/>
  </title-info><src-title-info><book-title>Not this</book-title></src-title-info></description></FictionBook>`;
  expect(parseFb2(xml)).toEqual({
    title: "Понедельник начинается в субботу",
    authors: ["Аркадий Натанович Стругацкий", "Сидоров"],
    year: 1965,
    language: "ru",
    series: "Сказки",
    description: "Сказка для научных работников.\nВторая.",
  });
  expect(parseFb2("<FictionBook></FictionBook>")).toEqual({});
});

test("extraction opens EPUB and FB2 files (a windows-1251 one too), and a damaged or other file yields nothing instead of an error", async () => {
  const dir = join(base, "files");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.epub"), epub(OPF));
  expect((await extractMeta(join(dir, "a.epub"), "epub")).title).toBe("Радиоприёмники & усилители");

  const head = new TextEncoder().encode(`<?xml version="1.0" encoding="windows-1251"?><FictionBook><description><title-info><book-title>`);
  const tail = new TextEncoder().encode(`</book-title></title-info></description></FictionBook>`);
  const name = cp1251("Война");
  writeFileSync(join(dir, "b.fb2"), Uint8Array.from([...head, ...name, ...tail]));
  expect(await extractMeta(join(dir, "b.fb2"), "fb2")).toEqual({ title: "Война" });

  writeFileSync(join(dir, "broken.epub"), "this is not a zip");
  await expect(extractMeta(join(dir, "broken.epub"), "epub")).rejects.toBeDefined(); // the library catches this and moves on
  expect(await extractMeta(join(dir, "a.epub"), "pdf")).toEqual({});
});

test("what is typed is trimmed and checked, a blank is a value, a reset brings the extracted value back, and the rest is refused", () => {
  const manual = applyEdit({}, { title: "  My   book ", authors: [" A ", "", "B"], year: 1949, tags: ["Радио", "радио", " схемы "], language: "RU" }, undefined);
  expect(manual).toEqual({ title: "My book", authors: ["A", "B"], year: 1949, tags: ["Радио", "схемы"], language: "ru" });

  const auto = { title: "From file", authors: ["Someone"], year: 1950, series: "S" };
  expect(effective({}, auto)).toMatchObject({ title: "From file", authors: ["Someone"], year: 1950, series: "S", tags: [], description: "" });
  expect(effective(manual, auto)).toMatchObject({ title: "My book", authors: ["A", "B"], year: 1949, series: "S" }); // series was not typed: the file's shows
  expect(effective({ title: "", year: null }, auto)).toMatchObject({ title: "", year: null }); // a blank hides what the file says
  expect(shelfFields({ manual: { title: "" }, auto, autoVersion: 1 }, "file name").title).toBe("file name"); // and the shelf never shows an empty name
  expect(shelfFields(undefined, "file name")).toEqual({ title: "file name", authors: [], year: null, series: "", tags: [] });

  const reset = applyEdit(manual, { series: "Own" }, ["title", "year"]);
  expect(reset).toEqual({ authors: ["A", "B"], tags: ["Радио", "схемы"], language: "ru", series: "Own" });

  expect(failure(() => applyEdit({}, { title: "x".repeat(MAX_TITLE + 1) }, undefined))).toBe("title");
  expect(failure(() => applyEdit({}, { year: 1949.5 }, undefined))).toBe("year");
  expect(failure(() => applyEdit({}, { year: "1949" }, undefined))).toBe("year");
  expect(failure(() => applyEdit({}, { language: "not a language" }, undefined))).toBe("language");
  expect(failure(() => applyEdit({}, { authors: "A" }, undefined))).toBe("authors");
  expect(failure(() => applyEdit({}, { tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`) }, undefined))).toBe("tags");
  expect(failure(() => applyEdit({}, { tags: ["x".repeat(41)] }, undefined))).toBe("tags");
  expect(failure(() => applyEdit({}, { colour: "red" }, undefined))).toBe("unknown field");
  expect(failure(() => applyEdit({}, undefined, ["colour"]))).toBe("reset");
  expect(failure(() => applyEdit({}, [], undefined))).toBe("set");
  expect(failure(() => cleanManual({ title: 5 }))).toBe("title");
});

test("a scan reads titles and authors out of EPUB and FB2 files once, and the library finds a book by them whatever the file is called", async () => {
  const { lib, library } = install();
  writeFileSync(join(lib, "scan0042.epub"), epub(OPF));
  writeFileSync(join(lib, "plain.txt"), "just text");
  writeFileSync(join(lib, "x.fb2"), `<FictionBook><description><title-info><author><first-name>Иван</first-name><last-name>Ефремов</last-name></author><book-title>Туманность Андромеды</book-title></title-info></description></FictionBook>`);
  await library.setRoot(lib);
  expect(await library.fillMeta()).toBe(2); // the reading the scan started (the EPUB and the FB2; a text file has none) is the one waited for
  expect(await library.fillMeta()).toBe(0); // and a second ask finds nothing left
  const epubBook = library.books().find((b) => b.name === "scan0042")!;
  expect(shelfFields(library.meta.row(epubBook.id), epubBook.name)).toMatchObject({ title: "Радиоприёмники & усилители", authors: ["И. Г. Беляев", "В. Петров"], year: 1949, series: "Массовая радиобиблиотека" });
  const txt = library.books().find((b) => b.name === "plain")!;
  expect(shelfFields(library.meta.row(txt.id), txt.name).title).toBe("plain"); // no metadata in a text file: the file's name

  const search = (q: string) => library.searchNames(q).map((b) => b.name);
  expect(search("беляев")).toEqual(["scan0042"]); // an author, in any letter case (a Cyrillic one too)
  expect(search("ТУМАННОСТЬ")).toEqual(["x"]); // a title
  expect(search("радиобиблиотека")).toEqual(["scan0042"]); // a series
  expect(search("plain")).toEqual(["plain"]); // a file name, as before
  expect(search("nothing like this")).toEqual([]);

  const row = library.meta.row(epubBook.id)!;
  writeFileSync(join(lib, "later.txt"), "added after");
  await library.rescan();
  await library.fillMeta();
  expect(library.meta.row(epubBook.id)).toEqual(row); // read once, not again
});

test("what the administrator typed survives a rename, a move and a rescan, and stays with the content when the file changes place", async () => {
  const { lib, library } = install();
  writeFileSync(join(lib, "book.epub"), epub(OPF));
  await library.setRoot(lib);
  await library.fillMeta();
  const id = library.books()[0]!.id;
  library.meta.edit(id, { title: "Моё название", tags: ["радио"] }, undefined);

  mkdirSync(join(lib, "Shelf"));
  renameSync(join(lib, "book.epub"), join(lib, "Shelf", "renamed.epub"));
  await library.rescan();
  await library.fillMeta();
  const moved = library.books()[0]!;
  expect(moved.path).toBe("Shelf/renamed.epub");
  expect(moved.id).toBe(id);
  expect(shelfFields(library.meta.row(id), moved.name)).toMatchObject({ title: "Моё название", tags: ["радио"], authors: ["И. Г. Беляев", "В. Петров"] }); // typed title wins, the file's authors still show
  expect(library.searchNames("моё название")).toHaveLength(1);
  expect(library.meta.tags()).toEqual([{ tag: "радио", books: 1 }]);
});

test("the tag list counts each book once per tag, ignoring letter case, most used first", () => {
  const { db } = install();
  const meta = new BookMeta(db);
  meta.edit("a".repeat(20), { tags: ["Радио", "лампы"] }, undefined);
  meta.edit("b".repeat(20), { tags: ["радио"] }, undefined);
  meta.edit("c".repeat(20), { title: "No tags" }, undefined);
  expect(meta.tags()).toEqual([{ tag: "Радио", books: 2 }, { tag: "лампы", books: 1 }]);
});

test("a backup carries what was typed, not what the files say, and restoring puts it back; an older backup leaves the cards alone", async () => {
  const a = install();
  const meta = new BookMeta(a.db);
  const ID1 = "0123456789abcdef0123";
  const ID2 = "fedcba9876543210fedc";
  meta.setAuto(ID1, { title: "From the file" });
  meta.edit(ID1, { title: "Typed", tags: ["x"] }, undefined);
  meta.setAuto(ID2, { title: "Only the file" }); // nothing typed: not in the backup

  // the administrator is needed in any backup
  const { Auth } = await import("./auth");
  await new Auth(a.db).createUser("Alex", "secret1", "admin");
  const file = new Backup(a.db, a.config).create();
  expect(file.bookMeta).toEqual([{ bookId: ID1, manual: { title: "Typed", tags: ["x"] } }]);
  expect(JSON.stringify(file)).not.toContain("From the file");

  const b = install();
  const other = new BookMeta(b.db);
  other.edit(ID2, { title: "Old card" }, undefined);
  other.setAuto(ID1, { title: "Read here" });
  new Backup(b.db, b.config).restore(parseBackup(JSON.parse(JSON.stringify(file))));
  expect(other.row(ID1)).toMatchObject({ manual: { title: "Typed", tags: ["x"] }, auto: { title: "Read here" } }); // the file's own values were not touched
  expect(other.row(ID2)!.manual).toEqual({}); // replaced, as the backup said

  const old = JSON.parse(JSON.stringify(file));
  delete old.bookMeta;
  other.edit(ID2, { title: "Typed later" }, undefined);
  new Backup(b.db, b.config).restore(parseBackup(old));
  expect(other.row(ID2)!.manual).toEqual({ title: "Typed later" }); // a backup that never had cards changes none

  for (const broken of [{ bookId: "nope", manual: {} }, { bookId: ID1, manual: { colour: "red" } }, { bookId: ID1, manual: { year: "1949" } }]) {
    expect(() => parseBackup({ ...JSON.parse(JSON.stringify(file)), bookMeta: [broken] })).toThrow();
  }
  expect(() => parseBackup({ ...JSON.parse(JSON.stringify(file)), bookMeta: [{ bookId: ID1, manual: {} }, { bookId: ID1, manual: {} }] })).toThrow(); // one card per book
});
