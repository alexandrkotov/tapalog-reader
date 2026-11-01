import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Covers } from "./covers";
import { removeDir } from "./testutil";

const dir = mkdtempSync(join(tmpdir(), "reader-covers-"));
afterAll(() => removeDir(dir));

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, ...new Array(200).fill(1)]);
const book = (id: string, ext = "pdf") => ({ id, path: `${id}.${ext}`, name: id, ext, size: 1 });
const A = "a".repeat(20);
const B = "b".repeat(20);
const C = "c".repeat(20);

test("covers survive a restart, and identical books are listed once", () => {
  const covers = new Covers(dir);
  expect(covers.save(A, jpeg)).toBe(true);
  covers.markNone(B);
  const again = new Covers(dir);
  expect(again.has(A)).toBe(true);
  expect(again.missing([book(A), book(B), book(C), { ...book(C), path: "copy.pdf" }, book("d".repeat(20), "txt")], 10)).toEqual({ todo: [book(C)], remaining: 1 });
  expect(again.missing([book(C)], 0)).toEqual({ todo: [], remaining: 1 });
});

test("ids that could name another path are refused", () => {
  const covers = new Covers(dir);
  expect(covers.save("../../etc/passwd", jpeg)).toBe(false);
  expect(covers.file("../x")).toBeNull();
});

test("only covers of long-missing books are pruned", () => {
  const covers = new Covers(dir);
  covers.save(C, jpeg);
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  utimesSync(join(dir, "covers", `${A}.jpg`), old, old);
  expect(covers.prune(new Set([B]))).toBe(1); // A is old and unused; C is unused but recent
  expect(covers.has(A)).toBe(false);
  expect(covers.has(C)).toBe(true);
  covers.save(A, jpeg);
  utimesSync(join(dir, "covers", `${A}.jpg`), old, old);
  expect(covers.prune(new Set([A]))).toBe(0); // old but its book is still there
});
