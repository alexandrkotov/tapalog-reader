import { expect, test } from "bun:test";
import { placeHash, searchHash } from "./searchAddress";
import { NO_FILTERS } from "./shelfView";

test("the address of a search holds the words and only the filters that are on", () => {
  expect(searchHash("pentode", NO_FILTERS)).toBe("#search=pentode");
  expect(searchHash("a b&c", { format: "pdf", tag: "радио", author: " Беляев " })).toBe(`#search=a+b%26c&format=pdf&tag=${encodeURIComponent("радио")}&author=${encodeURIComponent("Беляев")}`);
  const params = new URLSearchParams(searchHash("a b&c", { format: "", tag: "x", author: "" }).slice(1));
  expect(params.get("search")).toBe("a b&c"); // read back as it was typed
  expect(params.get("tag")).toBe("x");
});

test("a place in a book is a link that opens the book at that place", () => {
  expect(placeHash("abc", null)).toBe("#book=abc");
  const hash = placeHash("abc", { v: 1, page: 4 });
  expect(hash.startsWith("#book=abc&view=")).toBe(true);
  expect(JSON.parse(decodeURIComponent(hash.split("view=")[1]!))).toEqual({ v: 1, page: 4 });
});

test("the words a search found go with the link, in the address, and only when there are some", () => {
  expect(placeHash("abc", null, ["пентод"])).toBe(`#book=abc&find=${encodeURIComponent("пентод")}`);
  const hash = placeHash("abc", { v: 1, page: 4 }, ["поменять", "местами"]);
  expect(new URLSearchParams(hash.slice(1)).get("find")).toBe("поменять местами");
  expect(JSON.parse(new URLSearchParams(hash.slice(1)).get("view")!)).toEqual({ v: 1, page: 4 });
  expect(placeHash("abc", { v: 1, page: 4 }, [])).not.toContain("find");
});
