import { expect, test } from "bun:test";
import { cleanOcrText, MAX_PAGE_CHARS, validLang } from "./ocr";

test("a word split by a hyphen at the end of a line is joined, and the lines of a paragraph run on", () => {
  expect(cleanOcrText("Основные параметры этих термосопротивлений при-\nведены в табл. 10-4.\nНовая строка.")).toBe("Основные параметры этих термосопротивлений приведены в табл. 10-4. Новая строка.");
  expect(cleanOcrText("Тире — не перенос -\nСтрока с большой буквы")).toBe("Тире — не перенос - Строка с большой буквы"); // a hyphen before a capital stays
  expect(cleanOcrText("First paragraph.\n\n\n\nSecond one.")).toBe("First paragraph.\n\nSecond one.");
});

test("what would break the snippets or fill the index is taken out", () => {
  expect(cleanOcrText("a\u0001b\u0002c\u0000d")).toBe("a b c d"); // the marks of a found word are never in a page's text
  expect(cleanOcrText("  \r\n \t ")).toBe("");
  expect(cleanOcrText("x".repeat(MAX_PAGE_CHARS + 5)).length).toBe(MAX_PAGE_CHARS);
});

test("only the languages the engine ships with are accepted", () => {
  expect(validLang("rus")).toBe(true);
  expect(validLang("rus+eng")).toBe(true);
  expect(validLang("deu")).toBe(false);
  expect(validLang(undefined)).toBe(false);
});
