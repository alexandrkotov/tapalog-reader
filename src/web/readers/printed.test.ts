import { expect, test } from "bun:test";
import { fileOf, offsetFor, printedOf } from "./printed";

test("printed numbers follow the file's by the offset, and pages before printed page 1 have none", () => {
  const offset = offsetFor(13, 1); // file page 13 is printed page 1
  expect(offset).toBe(12);
  expect(printedOf(13, offset)).toBe(1);
  expect(printedOf(58, offset)).toBe(46);
  expect(printedOf(12, offset)).toBeNull();
  expect(printedOf(1, offset)).toBeNull();
  expect(fileOf(46, offset)).toBe(58);
  expect(fileOf(1, offset)).toBe(13);
});

test("a scan that starts after printed page 1 has a negative offset", () => {
  const offset = offsetFor(1, 5); // the first file page is printed page 5
  expect(offset).toBe(-4);
  expect(printedOf(1, offset)).toBe(5);
  expect(printedOf(10, offset)).toBe(14);
  expect(fileOf(5, offset)).toBe(1);
});

test("with no offset the numbers are the same", () => {
  expect(printedOf(7, 0)).toBe(7);
  expect(fileOf(7, 0)).toBe(7);
});
