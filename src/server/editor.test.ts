import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { EditError, LibraryEditor, validName } from "./editor";
import { Library } from "./library";

const base = mkdtempSync(join(tmpdir(), "reader-edit-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let lib: string;
let data: string;
let library: Library;
let editor: LibraryEditor;
let n = 0;

beforeEach(async () => {
  const dir = join(base, String(n++));
  lib = join(dir, "lib");
  data = join(lib, "tapalog-reader-data"); // next to the executable, inside the library: the common case
  mkdirSync(join(lib, "A/inner"), { recursive: true });
  mkdirSync(join(lib, "B"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(lib, "one.txt"), "first");
  writeFileSync(join(lib, "A/two.TXT"), "second");
  writeFileSync(join(lib, "A/inner/three.txt"), "third");
  writeFileSync(join(lib, "B/one.txt"), "other one");
  const config = new ConfigStore(join(dir));
  library = new Library(openDb(dir), config, data);
  await library.setRoot(lib);
  editor = new LibraryEditor(library, data);
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof EditError) return err.code;
    throw err;
  }
  return "ok";
};
const paths = () => library.books().map((b) => b.path);

test("a book moves into another folder on disk and in the index, keeping its id", () => {
  const id = library.bookAt("one.txt")!.id;
  expect(code(() => editor.move("book", "one.txt", "A/inner"))).toBe("ok");
  expect(existsSync(join(lib, "A/inner/one.txt"))).toBe(true);
  expect(existsSync(join(lib, "one.txt"))).toBe(false);
  expect(library.bookAt("A/inner/one.txt")).toMatchObject({ id, name: "one" });
  expect(library.bookAt("one.txt")).toBeNull();
});

test("nothing is overwritten and nothing moves to where it already is", () => {
  expect(code(() => editor.move("book", "one.txt", "B"))).toBe("exists"); // B/one.txt is a different book
  expect(readFileSync(join(lib, "B/one.txt"), "utf-8")).toBe("other one");
  expect(code(() => editor.move("book", "A/two.TXT", "A"))).toBe("same-place");
  expect(code(() => editor.rename("book", "one.txt", "B"))).toBe("ok");
  expect(code(() => editor.rename("folder", "A", "B"))).toBe("exists");
});

test("a folder takes its books and sub-folders along, and cannot go into itself", () => {
  expect(code(() => editor.move("folder", "A", "A/inner"))).toBe("into-itself");
  expect(code(() => editor.move("folder", "A", "A"))).toBe("into-itself");
  expect(code(() => editor.move("folder", "A", "B"))).toBe("ok");
  expect(paths().sort()).toEqual(["B/A/inner/three.txt", "B/A/two.TXT", "B/one.txt", "one.txt"]);
  expect(library.folders().sort()).toEqual(["B", "B/A", "B/A/inner"]);
  expect(existsSync(join(lib, "B/A/inner/three.txt"))).toBe(true);
});

test("a book keeps its extension when renamed, a folder rename updates everything under it", () => {
  expect(code(() => editor.rename("book", "A/two.TXT", "Second part"))).toBe("ok");
  expect(existsSync(join(lib, "A/Second part.TXT"))).toBe(true);
  expect(library.bookAt("A/Second part.TXT")).toMatchObject({ name: "Second part", ext: "txt" });
  expect(code(() => editor.rename("folder", "A", "Alpha"))).toBe("ok");
  expect(paths().sort()).toEqual(["Alpha/Second part.TXT", "Alpha/inner/three.txt", "B/one.txt", "one.txt"]);
  expect(library.folders().sort()).toEqual(["Alpha", "Alpha/inner", "B"]);
});

test("a folder with LIKE wildcards in its name does not drag its neighbours along", () => {
  mkdirSync(join(lib, "50%_off"));
  mkdirSync(join(lib, "50xxoff"));
  writeFileSync(join(lib, "50xxoff/safe.txt"), "safe");
  writeFileSync(join(lib, "50%_off/mine.txt"), "mine");
  return library.rescan().then(() => {
    expect(code(() => editor.rename("folder", "50%_off", "Sale"))).toBe("ok");
    expect(library.bookAt("50xxoff/safe.txt")).not.toBeNull();
    expect(library.bookAt("Sale/mine.txt")).not.toBeNull();
  });
});

test("new folders: nested, unique, and with safe names only", () => {
  expect(editor.mkdir("A", "Fresh")).toBe("A/Fresh");
  expect(library.folders()).toContain("A/Fresh");
  expect(existsSync(join(lib, "A/Fresh"))).toBe(true);
  expect(code(() => editor.mkdir("A", "Fresh"))).toBe("exists");
  expect(code(() => editor.mkdir("nowhere", "x"))).toBe("missing");
  for (const bad of ["", "  ", ".hidden", "a/b", "a\\b", "..", "x.", "con", "NUL.txt", "q?", "a".repeat(201)]) expect(code(() => editor.mkdir("", bad))).toBe("invalid-name");
});

test("only what the library lists can be touched, and never the folder with the app's own data", () => {
  expect(code(() => editor.move("book", "../outside.txt", "A"))).toBe("missing");
  expect(code(() => editor.move("book", "one.txt", "../elsewhere"))).toBe("missing");
  expect(code(() => editor.rename("folder", "", "x"))).toBe("missing");
  expect(code(() => editor.rename("book", "nope.txt", "x"))).toBe("missing");
  // the data folder sits inside the library here; moving the folder that holds it must be refused
  const guarded = new LibraryEditor(library, join(lib, "A/inner/data"));
  mkdirSync(join(lib, "A/inner/data"), { recursive: true });
  expect(code(() => guarded.rename("folder", "A", "Z"))).toBe("forbidden");
  expect(code(() => guarded.move("folder", "A/inner", "B"))).toBe("forbidden");
  expect(code(() => guarded.rename("folder", "B", "Z"))).toBe("ok");
});

test("case-only renames are allowed, and a library that is not writable says so", () => {
  expect(code(() => editor.rename("book", "one.txt", "One"))).toBe("ok");
  expect(library.bookAt("One.txt")).not.toBeNull();
  expect(editor.writable).toBe(true);
  expect(new LibraryEditor(new Library(openDb(join(base, "0")), new ConfigStore(join(base, "none")), data), data).writable).toBe(false); // no library chosen
});

test("names that are fine everywhere pass, others are refused", () => {
  expect(validName("  Война и мир. Том 1  ")).toBe("Война и мир. Том 1");
  expect(() => validName(42)).toThrow(EditError);
});
