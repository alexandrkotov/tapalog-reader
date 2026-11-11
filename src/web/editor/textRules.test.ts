import { describe, expect, test } from "bun:test";
import { fromEditor, protectDollars, toEditor } from "./textRules";

describe("which dollars are formulas", () => {
  test("a formula is kept as it is", () => {
    expect(protectDollars("Формула $E=mc^2$ в тексте.")).toBe("Формула $E=mc^2$ в тексте.");
    expect(protectDollars("$a$ и $b$")).toBe("$a$ и $b$");
  });

  test("prices are not formulas", () => {
    expect(protectDollars("цена $5 и $6 за штуку")).toBe("цена \\$5 и \\$6 за штуку");
    expect(protectDollars("стоит $5.\nИ ещё $10.")).toBe("стоит \\$5.\nИ ещё \\$10.");
    expect(protectDollars("только один $ знак")).toBe("только один \\$ знак");
    expect(protectDollars("в конце $")).toBe("в конце \\$");
  });

  test("a price beside a real formula does not spoil it", () => {
    expect(protectDollars("$x$ стоит $5")).toBe("$x$ стоит \\$5");
    expect(protectDollars("Цена $5 и $6. Формула $E=mc^2$.")).toBe("Цена \\$5 и \\$6. Формула $E=mc^2$.");
    expect(protectDollars("$5 за $x+1$")).toBe("\\$5 за $x+1$");
  });

  test("a block formula and an escaped dollar are left alone", () => {
    expect(protectDollars("До.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nПосле $5.")).toBe("До.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nПосле \\$5.");
    expect(protectDollars("уже \\$5")).toBe("уже \\$5");
  });

  test("a formula does not reach into the next paragraph", () => {
    expect(protectDollars("раз $5\n\nдва $6")).toBe("раз \\$5\n\nдва \\$6");
  });
});

describe("what comes out of the editor", () => {
  test("loses the closing line break and the backslash breaks", () => {
    expect(fromEditor("строка\\\nвторая\n")).toBe("строка\nвторая");
    expect(fromEditor("одна\n\nдве\n\n")).toBe("одна\n\nдве");
  });

  test("gives the dollars back, and the other signs the editor protected", () => {
    expect(fromEditor("цена \\$5 и \\$6\n")).toBe("цена $5 и $6");
    expect(fromEditor("3 \\* 4 и \\[1] и a\\_b\n")).toBe("3 * 4 и [1] и a_b");
  });

  test("a text with prices comes back as it went in", () => {
    const text = "цена $5 и $6 за штуку\nи $x$ формула";
    expect(fromEditor(toEditor(text))).toBe(text);
  });
});

describe("an empty paragraph", () => {
  test("the line of <br /> the editor writes for it is not kept, and one an older page holds is not shown", () => {
    expect(fromEditor("раз\n\n<br />\n\nдва\n")).toBe("раз\n\nдва");
    expect(toEditor("раз\n\n<br />\n\nдва")).toBe("раз\n\nдва");
  });
});
