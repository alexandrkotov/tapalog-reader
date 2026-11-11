import { describe, expect, test } from "bun:test";
import { dropBreaks, formulaLook, inlineRuns, plainText, scanDollars, withLook } from "./markup";

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

describe("the look of a formula", () => {
  test("size and weight are read out of the LaTeX and put back", () => {
    expect(formulaLook("x^2")).toEqual({ body: "x^2", size: 0, bold: false });
    expect(formulaLook("\\Large x^2")).toEqual({ body: "x^2", size: 1, bold: false });
    expect(formulaLook("\\huge \\boldsymbol{a_1 + b}")).toEqual({ body: "a_1 + b", size: 2, bold: true });
    expect(formulaLook("\\Huge\\boldsymbol{x}")).toEqual({ body: "x", size: 3, bold: true });
    for (const look of [{ body: "E=mc^2", size: 0, bold: false }, { body: "E=mc^2", size: 3, bold: true }, { body: "\\frac{1}{2}", size: 1, bold: true }]) {
      expect(formulaLook(withLook(look))).toEqual(look);
    }
    expect(withLook({ body: "x", size: 2, bold: true })).toBe("\\huge \\boldsymbol{x}");
  });

  test("a formula that only starts like a look is left as it is", () => {
    // \boldsymbol{a} + \boldsymbol{b} is not one bold formula; \Largest is no size
    expect(formulaLook("\\boldsymbol{a} + \\boldsymbol{b}")).toEqual({ body: "\\boldsymbol{a} + \\boldsymbol{b}", size: 0, bold: false });
    expect(formulaLook("\\Largest x").size).toBe(0);
    expect(formulaLook("\\boldsymbol{a \\} b}")).toEqual({ body: "a \\} b", size: 0, bold: true });
  });

  test("the runs and the plain text carry the weight and none of the commands", () => {
    expect(inlineRuns("раз $\\Large \\boldsymbol{x^2}$ два")).toEqual([{ text: "раз " }, { text: "x^2", formula: true, bold: true }, { text: " два" }]);
    expect(plainText("раз $\\huge x$ два\n\n$$\n\\Huge \\boldsymbol{\\frac{1}{2}}\n$$", "keep")).toBe("раз x два\n\n\\frac{1}{2}");
  });
});

describe("an empty paragraph", () => {
  test("a line of <br /> is dropped and the blank lines around it become one", () => {
    expect(dropBreaks("раз\n\n<br />\n\nдва")).toBe("раз\n\nдва");
    expect(dropBreaks("раз\n\n<br>\n\n<br/>\n\nдва")).toBe("раз\n\nдва");
    expect(dropBreaks("раз <br /> два")).toBe("раз <br /> два"); // only a line of its own
    expect(dropBreaks("без этого")).toBe("без этого");
  });

  test("plain text for the index and for a file does not hold it", () => {
    expect(plainText("раз\n\n<br />\n\nдва", "drop")).toBe("раз\n\nдва");
    expect(plainText("раз\n\n<br />\n\nдва", "keep")).toBe("раз\n\nдва");
  });
});
