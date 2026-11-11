import { describe, expect, test } from "bun:test";
import { inlineRuns, plainText, scanDollars } from "./markup";

describe("the dollars of a line", () => {
  test("a formula and a price are told apart", () => {
    expect(scanDollars("Цена $5 и $6. Формула $E=mc^2$.")).toEqual({ formulas: [[22, 30]], prices: [5, 10] });
    expect(scanDollars("уже \\$5 и $$блок$$")).toEqual({ formulas: [], prices: [] });
  });
});

describe("the runs of a line", () => {
  test("plain text is one run", () => {
    expect(inlineRuns("просто текст, 3 * 4 и snake_case_name")).toEqual([{ text: "просто текст, 3 * 4 и snake_case_name" }]);
  });

  test("bold, italic and code", () => {
    expect(inlineRuns("раз **жирный** два *курсив* три `код` и _ещё_")).toEqual([
      { text: "раз " },
      { text: "жирный", bold: true },
      { text: " два " },
      { text: "курсив", italic: true },
      { text: " три код и " },
      { text: "ещё", italic: true },
    ]);
  });

  test("italics inside bold", () => {
    expect(inlineRuns("**жирный *и курсив* вместе**")).toEqual([{ text: "жирный ", bold: true }, { text: "и курсив", bold: true, italic: true }, { text: " вместе", bold: true }]);
  });

  test("a formula is its own run, and a price stays text", () => {
    expect(inlineRuns("Цена $5 и $6, а $x^2$ — формула")).toEqual([{ text: "Цена $5 и $6, а " }, { text: "x^2", formula: true }, { text: " — формула" }]);
  });

  test("a sign the editor protected is plain again", () => {
    expect(inlineRuns("3 \\* 4 и \\[1]")).toEqual([{ text: "3 * 4 и [1]" }]);
  });
});

describe("plain text", () => {
  const page = "### Итог\n\nЭто **важно** и *ещё* `так`.\n> цитата\n\nФормула $x^2$ в строке.\n\n$$\n\\frac{1}{2}\n$$\n\nКонец, цена $5.";

  test("for the index no marks and no formulas", () => {
    expect(plainText(page, "drop")).toBe("Итог\n\nЭто важно и ещё так.\nцитата\n\nФормула  в строке.\n\nКонец, цена $5.");
  });

  test("for a text file the formulas are written in LaTeX without dollars", () => {
    expect(plainText(page, "keep")).toBe("Итог\n\nЭто важно и ещё так.\nцитата\n\nФормула x^2 в строке.\n\n\\frac{1}{2}\n\nКонец, цена $5.");
  });

  test("a text that has no marks comes out as it was", () => {
    const text = "Ламповый радиоприёмник\nдля начинающих\n\nВторой абзац, 3 * 4 = 12.";
    expect(plainText(text, "drop")).toBe(text);
    expect(plainText(text, "keep")).toBe(text);
  });
});
