import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { findDuplicates, similarKey } from "./duplicates";
import { EditError, LibraryEditor, TRASH } from "./editor";
import { Library } from "./library";
import { removeDir } from "./testutil";

const base = mkdtempSync(join(tmpdir(), "reader-dups-"));
const opened: { close(): void }[] = [];
afterAll(() => {
  for (const x of opened) x.close();
  removeDir(base);
});

/** A PDF-like file of `size` bytes: the same head and tail for every `seed`, a different middle. */
const book = (size: number, seed: number) => {
  const bytes = new Uint8Array(size).fill(65);
  bytes.set(new TextEncoder().encode("%PDF-1.4 "), 0);
  bytes[Math.floor(size / 2)] = seed; // outside the 64 KB at both ends, which the library's id is made of
  return bytes;
};

let lib: string;
let library: Library;
let editor: LibraryEditor;

beforeAll(async () => {
  lib = join(base, "lib");
  const data = join(lib, "tapalog-reader-data");
  mkdirSync(join(lib, "Radio"), { recursive: true });
  mkdirSync(join(lib, "Old"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const same = book(300_000, 1);
  writeFileSync(join(lib, "Schemes.pdf"), same);
  writeFileSync(join(lib, "Radio", "Schemes copy.pdf"), same); // the same content under another name and in another folder
  writeFileSync(join(lib, "Old", "Schemes 1957.pdf"), same);
  writeFileSync(join(lib, "Twin A.pdf"), book(300_000, 2)); // the same size, head and tail, so the same library id, but another middle
  writeFileSync(join(lib, "Radio", "Twin B.pdf"), book(300_000, 3));
  writeFileSync(join(lib, "Radio Handbook.pdf"), book(1000, 4)); // alike by name only
  writeFileSync(join(lib, "Old", "radio-handbook (копия).epub"), "PK a different file");
  writeFileSync(join(lib, "Fb.pdf"), book(900, 5));
  writeFileSync(join(lib, "Old", "fb.pdf"), book(901, 6)); // too short a name to say anything
  mkdirSync(join(base, "db"), { recursive: true });
  const db = openDb(join(base, "db"));
  library = new Library(db, new ConfigStore(join(base, "db")), data);
  opened.push(db, library);
  await library.setRoot(lib);
  editor = new LibraryEditor(library, data);
});

test("names are compared without case, punctuation, accents and the word copy", () => {
  expect(similarKey("Radio-Handbook (копия)")).toBe("radio handbook");
  expect(similarKey("Radio  Handbook_Copy")).toBe("radio handbook");
  expect(similarKey("Café Müller")).toBe("cafe muller");
  expect(similarKey("Vol. 1")).not.toBe(similarKey("Vol. 2"));
});

test("identical files are found whole, and files that only look alike to the library are not", async () => {
  const { exact } = await findDuplicates(library);
  expect(exact).toHaveLength(1); // Twin A and Twin B share a library id but differ in the middle: not identical
  expect(exact[0]!.items.map((i) => i.path).sort()).toEqual(["Old/Schemes 1957.pdf", "Radio/Schemes copy.pdf", "Schemes.pdf"]);
  expect(exact[0]!.items[0]).toMatchObject({ ext: "pdf", size: 300_000 });
  expect(exact[0]!.items[0]!.mtime).toBeGreaterThan(0);
});

test("different files with alike names are offered separately, and short names are not compared", async () => {
  const { similar } = await findDuplicates(library);
  expect(similar.map((g) => g.items.map((i) => i.path).sort())).toEqual([["Old/radio-handbook (копия).epub", "Radio Handbook.pdf"]]);
});

test("books are taken out one copy at a time, never the last copy of a book that exists more than once", async () => {
  const copies = ["Schemes.pdf", "Radio/Schemes copy.pdf", "Old/Schemes 1957.pdf"];
  const refused = async (paths: string[]) => {
    try {
      await editor.trash(paths);
      return "no error";
    } catch (err) {
      return err instanceof EditError ? err.code : String(err);
    }
  };
  // the library's quick id is the same for all five 300 KB books here, but only three are identical
  expect(library.pathsWithId(library.bookAt("Twin A.pdf")!.id)).toHaveLength(5);
  expect(await refused(copies)).toBe("last-copy");
  expect(await refused([])).toBe("missing");
  expect(await refused(["Nothing here.pdf"])).toBe("missing");
  expect(await refused(["../outside.pdf"])).toBe("missing");
  expect(library.books()).toHaveLength(9);
  expect(await refused(["Twin A.pdf", "Radio/Twin B.pdf"])).toBe("no error"); // alike to the quick id, but not copies of each other: both may go
  expect(library.books()).toHaveLength(7);

  expect(await editor.trash(copies.slice(1))).toBe(2);
  expect(library.books().map((b) => b.path)).not.toContain("Radio/Schemes copy.pdf");
  expect(existsSync(join(lib, "Schemes.pdf"))).toBe(true);
  expect(existsSync(join(lib, "Radio", "Schemes copy.pdf"))).toBe(false);
  const trashed = readdirSync(join(lib, TRASH));
  expect(trashed).toHaveLength(4); // the two twins and the two copies
  expect(trashed.some((f) => f.endsWith(" Radio - Schemes copy.pdf"))).toBe(true); // the folder stays in the name

  expect(await refused(["Schemes.pdf", "Schemes.pdf"])).toBe("no error"); // a path listed twice is one book; it is the last copy now, but it exists once
  expect(existsSync(join(lib, "Schemes.pdf"))).toBe(false);
});

test("the trash is hidden from the library, also after a rescan", async () => {
  await library.rescan();
  expect(library.books().some((b) => b.path.includes(TRASH))).toBe(false);
  expect(library.folders().some((f) => f.includes(TRASH))).toBe(false);
  expect(library.books()).toHaveLength(4);
  const { exact } = await findDuplicates(library);
  expect(exact).toEqual([]);
});
