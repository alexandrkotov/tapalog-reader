import { expect, test } from "bun:test";
import { findParam, markedWords, termPattern, wordsOf } from "./found";

test("the words an index marked in a snippet come out once each, as they stand in the text", () => {
  expect(markedWords("...можно \u0001поменять\u0002 \u0001местами\u0002; их можно \u0001Поменять\u0002 ещё...")).toEqual(["поменять", "местами"]);
  expect(markedWords("no marks here")).toEqual([]);
  expect(markedWords("a \u0001b\u0002 c \u0001d")).toEqual(["b", "d"]); // an unclosed mark still gives its word
});

test("the words go into an address and come back", () => {
  expect(wordsOf(findParam(["поменять", "местами"]))).toEqual(["поменять", "местами"]);
  expect(wordsOf(null)).toEqual([]);
  expect(wordsOf("a  b ")).toEqual(["a", "b"]);
  expect(findParam(Array.from({ length: 20 }, (_, i) => `w${i}`)).split(" ")).toHaveLength(8);
  expect(findParam(["x".repeat(200)]).length).toBe(60);
});

test("the pattern finds whole words in any case and in any alphabet, and nothing inside another word", () => {
  const pattern = termPattern(["поменять", "местами"])!;
  const found = (text: string) => [...text.matchAll(pattern)].map((m) => m[0]);
  expect(found("Их можно ПОМЕНЯТЬ местами; поменяться, домами")).toEqual(["ПОМЕНЯТЬ", "местами"]);
  expect(found("café and CAFÉ")).toEqual([]);
  expect([...("café and CAFÉ".matchAll(termPattern(["café"])!))].map((m) => m[0])).toEqual(["café", "CAFÉ"]);
  expect(termPattern(["a+b", "(x)"])).not.toBeNull(); // signs of a pattern are plain
  expect("a+b and (x)".match(termPattern(["a+b"])!)?.[0]).toBe("a+b");
  expect(termPattern([])).toBeNull();
  expect(termPattern(["  "])).toBeNull();
});
