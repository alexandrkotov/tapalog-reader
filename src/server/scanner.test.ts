import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { scanLibrary } from "./scanner";

let lib: string;
let data: string;

beforeEach(() => {
  lib = mkdtempSync(join(tmpdir(), "reader-lib-"));
  data = mkdtempSync(join(tmpdir(), "reader-data-"));
});
afterEach(() => {
  rmSync(lib, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
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
  const db = openDb(data);
  const result = await scanLibrary(db, lib);
  expect(result).toMatchObject({ books: 2, added: 2, removed: 0 });
  expect(Object.keys(ids(db)).sort()).toEqual(["a/b/book.PDF", "a/story.fb2"]);
  expect((db.query("SELECT path FROM folders ORDER BY path").all() as { path: string }[]).map((r) => r.path)).toEqual(["a", "a/b"]);
});

test("a book keeps its id when renamed or moved", async () => {
  writeFileSync(join(lib, "old.epub"), "same content ".repeat(100));
  const db = openDb(data);
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
  const db = openDb(data);
  await scanLibrary(db, lib);
  rmSync(join(lib, "y.txt"));
  const result = await scanLibrary(db, lib);
  expect(result).toMatchObject({ books: 1, added: 0, removed: 1 });
});

test("the data folder inside the library is never scanned", async () => {
  const inner = join(lib, "tapalog-reader-data");
  mkdirSync(inner);
  writeFileSync(join(inner, "preview.pdf"), "cache");
  writeFileSync(join(lib, "real.pdf"), "book");
  const db = openDb(data);
  expect(await scanLibrary(db, lib, [inner])).toMatchObject({ books: 1 });
});
