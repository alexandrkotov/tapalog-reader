import { expect, test } from "bun:test";
import { ownText } from "./ocrOwn";

test("the pieces of a page are joined like lines of text, and a page with enough letters is taken as it is", () => {
  const text = ownText([{ str: "Схема первого" }, { str: "каскада", hasEOL: true }, { str: "усилителя низкой частоты и его питания", hasEOL: true }]);
  expect(text).toBe("Схема первого каскада\nусилителя низкой частоты и его питания");
});

test("a page with a number or a stamp only is not taken: its picture is read", () => {
  expect(ownText([{ str: "12" }])).toBeNull();
  expect(ownText([{ str: "   ", hasEOL: true }, { str: "Рис. 3" }])).toBeNull();
  expect(ownText([])).toBeNull();
});

test("the spaces do not count towards the letters, and pieces without a string (marks) are skipped", () => {
  const spaced = [{ str: "а   б   в   г   д   е   ж   з   и   к   л   м" }, {}, { str: "н о п р с т у ф х ц ч ш щ" }];
  expect(ownText(spaced)).toBe("а б в г д е ж з и к л м н о п р с т у ф х ц ч ш щ");
  expect(ownText(spaced, 40)).toBeNull();
});
