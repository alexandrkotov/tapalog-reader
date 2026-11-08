import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { scanLibrary } from "./scanner";
import { removeDir } from "./testutil";

let lib: string;
let data: string;
const open: ReturnType<typeof openDb>[] = [];
const database = () => {
  const db = openDb(data);
  open.push(db);
  return db;
};

beforeEach(() => {
  lib = mkdtempSync(join(tmpdir(), "reader-lib-"));
  data = mkdtempSync(join(tmpdir(), "reader-data-"));
});
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  removeDir(lib);
  removeDir(data);
});

const ids = (db: ReturnType<typeof openDb>) =>
  Object.fromEntries((db.query("SELECT path, id FROM books").all() as { path: string; id: string }[]).map((r) => [r.path, r.id]));

test("lists supported formats in nested folders and skips hidden and unknown files", async () => {
  mkdirSync(join(lib, "a/b"), { recursive: true });
  mkdirSync(join(lib, ".hidden"));
  writeFileSync(join(lib, "a/b/book.PDF"), "pdf");
  writeFileSync(join(lib, "a/story.fb2"), "fb2");
  writeFileSync(join(lib, "a/readme.md"), "ignored");
  writeFileSync(join(lib, ".hidden/secret.pdf"), "ignored");
  const db = database();
  const result = await scanLibrary(db, lib);
  expect(result).toMatchObject({ books: 2, added: 2, removed: 0 });
  expect(Object.keys(ids(db)).sort()).toEqual(["a/b/book.PDF", "a/story.fb2"]);
  expect((db.query("SELECT path FROM folders ORDER BY path").all() as { path: string }[]).map((r) => r.path)).toEqual(["a", "a/b"]);
});

test("a book keeps its id when renamed or moved", async () => {
  writeFileSync(join(lib, "old.epub"), "same content ".repeat(100));
  const db = database();
  await scanLibrary(db, lib);
  const before = ids(db)["old.epub"];
  mkdirSync(join(lib, "moved"));
  renameSync(join(lib, "old.epub"), join(lib, "moved/new name.epub"));
  const result = await scanLibrary(db, lib);
  expect(result).toMatchObject({ added: 1, removed: 1 });
  expect(ids(db)["moved/new name.epub"]).toBe(before!);
});

test("an unchanged file is not read again and a deleted one disappears", async () => {
  writeFileSync(join(lib, "x.txt"), "x");
  writeFileSync(join(lib, "y.txt"), "y");
  const db = database();
  await scanLibrary(db, lib);
  rmSync(join(lib, "y.txt"));
  const result = await scanLibrary(db, lib);
  expect(result).toMatchObject({ books: 1, added: 0, removed: 1 });
});

test("a scan whose picture of the disk went stale writes nothing", async () => {
  writeFileSync(join(lib, "x.txt"), "x");
  const db = database();
  expect(await scanLibrary(db, lib, [], () => true)).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 0 });
  expect(await scanLibrary(db, lib)).toMatchObject({ books: 1 }); // the next one, with nothing in between, does
});

test("the data folder inside the library is never scanned", async () => {
  const inner = join(lib, "tapalog-reader-data");
  mkdirSync(inner);
  writeFileSync(join(inner, "preview.pdf"), "cache");
  writeFileSync(join(lib, "real.pdf"), "book");
  const db = database();
  expect(await scanLibrary(db, lib, [inner])).toMatchObject({ books: 1 });
});

const addedOf = (db: ReturnType<typeof openDb>) =>
  Object.fromEntries((db.query("SELECT path, added FROM books").all() as { path: string; added: number }[]).map((r) => [r.path, r.added]));

test("a book's added date is the file's date at the first scan, the time of the scan for later books, and survives a move", async () => {
  const old = new Date("2020-03-04T10:00:00Z");
  writeFileSync(join(lib, "first.epub"), "first ".repeat(50));
  utimesSync(join(lib, "first.epub"), old, old);
  const db = database();
  await scanLibrary(db, lib);
  expect(addedOf(db)["first.epub"]).toBe(old.getTime()); // an old library: books are dated by their files

  const before = Date.now();
  writeFileSync(join(lib, "second.epub"), "second ".repeat(50));
  utimesSync(join(lib, "second.epub"), old, old);
  await scanLibrary(db, lib);
  expect(addedOf(db)["second.epub"]).toBeGreaterThanOrEqual(before); // a book that comes later is dated by the day it came
  expect(addedOf(db)["first.epub"]).toBe(old.getTime()); // and a rescan does not touch the old one

  mkdirSync(join(lib, "moved"));
  renameSync(join(lib, "second.epub"), join(lib, "moved/renamed.epub")); // moved outside the app: gone at one path, new at another
  const second = (db.query("SELECT added FROM books WHERE path = 'second.epub'").get() as { added: number }).added;
  await scanLibrary(db, lib);
  expect(addedOf(db)).toEqual({ "first.epub": old.getTime(), "moved/renamed.epub": second });
});

test("a database made before the added column gets it, dated by the files", () => {
  const db = new Database(join(data, "library.db"), { create: true });
  db.run("CREATE TABLE books (path TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL)");
  db.run("INSERT INTO books VALUES ('a.pdf', 'x', 'a', 'pdf', 1, 12345)");
  db.close();
  const upgraded = database();
  expect(addedOf(upgraded)).toEqual({ "a.pdf": 12345 });
});
