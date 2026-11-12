import { expect, test } from "bun:test";
import { CODE_LANGUAGES, codeLanguage, highlightCode } from "./codeBlocks";

const classesOf = (code: string, lang: string) => highlightCode(code, lang).map(([from, to, cls]) => `${code.slice(from, to)}:${cls}`);

test("a language is found by its name in the fence, its short names and its title, and an unknown one is none", () => {
  expect(codeLanguage("python")?.id).toBe("python");
  expect(codeLanguage("PY")?.id).toBe("python");
  expect(codeLanguage("c++")?.id).toBe("cpp");
  expect(codeLanguage("Visual Basic")?.id).toBe("vb");
  expect(codeLanguage("vbs")?.id).toBe("vbscript");
  expect(codeLanguage("klingon")).toBeUndefined();
  expect(codeLanguage("")).toBeUndefined();
  expect(new Set(CODE_LANGUAGES.map((l) => l.id)).size).toBe(CODE_LANGUAGES.length);
});

test("code is coloured by what it is: keywords, strings, numbers and comments", () => {
  const python = classesOf('def f(x):\n    return "a" + 42  # done', "python");
  expect(python).toContain("def:tok-keyword");
  expect(python).toContain("return:tok-keyword");
  expect(python).toContain('"a":tok-string');
  expect(python).toContain("42:tok-number");
  expect(python.some((p) => p.endsWith(":tok-comment") && p.includes("done"))).toBe(true);
  expect(classesOf("Dim x As Integer ' note", "vb")).toContain("Dim:tok-keyword");
  expect(classesOf("SELECT name FROM t WHERE id = 5", "sql").some((p) => p.startsWith("SELECT"))).toBe(true);
});

test("what a mode keeps from one line to the next is kept: a string over lines stays a string", () => {
  const code = 'x = """one\ntwo"""\ny = 1';
  const ranges = highlightCode(code, "python");
  const second = code.indexOf("two");
  expect(ranges.some(([from, to, cls]) => cls === "tok-string" && from <= second && to > second)).toBe(true);
});

test("a language that is not known, an empty code and odd text leave the code plain and never throw", () => {
  expect(highlightCode("whatever", "klingon")).toEqual([]);
  expect(highlightCode("", "python")).toEqual([]);
  for (const language of CODE_LANGUAGES) expect(() => highlightCode('}{ "unclosed\n\t<<<\n/* ( [ \\', language.id)).not.toThrow();
});
