import { expect, test } from "bun:test";
import { countTags, parseTags, tagsHash, toggleTag, withAllTags } from "./tags";

const books = [
  { name: "a", tags: ["Радио", "схемы"] },
  { name: "b", tags: ["радио"] },
  { name: "c", tags: ["Радио", "радио", "лампы"] }, // a book counts once for a tag, whatever the spelling
  { name: "d", tags: [] },
];

test("tags are counted case-insensitively, written the way most books write them, most used first", () => {
  expect(countTags(books)).toEqual([
    { key: "радио", label: "Радио", count: 3 }, // a book counts once, under the first spelling it has: two books say "Радио", one "радио"
    { key: "лампы", label: "лампы", count: 1 },
    { key: "схемы", label: "схемы", count: 1 },
  ]);
  expect(countTags([])).toEqual([]);
});

test("books are chosen by all the tags at once, in any letter case", () => {
  expect(withAllTags(books, ["радио"]).map((b) => b.name)).toEqual(["a", "b", "c"]);
  expect(withAllTags(books, ["радио", "схемы"]).map((b) => b.name)).toEqual(["a"]);
  expect(withAllTags(books, ["схемы", "лампы"])).toEqual([]);
  expect(withAllTags(books, [])).toBe(books); // no choice: every book
});

test("a choice of tags goes into the address and comes back, and a click adds or takes out one", () => {
  expect(tagsHash(["радио", "схемы"])).toBe("#tags=%D1%80%D0%B0%D0%B4%D0%B8%D0%BE,%D1%81%D1%85%D0%B5%D0%BC%D1%8B");
  expect(tagsHash([])).toBe("#");
  const back = parseTags(new URLSearchParams(tagsHash(["радио", "схемы"]).slice(1)).get("tags"));
  expect(back).toEqual(["радио", "схемы"]);
  expect(parseTags(" Радио,, радио ,Схемы")).toEqual(["радио", "схемы"]);
  expect(parseTags(null)).toEqual([]);
  expect(toggleTag(["a"], "b")).toEqual(["a", "b"]);
  expect(toggleTag(["a", "b"], "a")).toEqual(["b"]);
});
