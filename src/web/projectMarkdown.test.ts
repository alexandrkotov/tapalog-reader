import { expect, test } from "bun:test";
import { markdownFileName, projectMarkdown, type MarkdownItem, type MarkdownLabels } from "./projectMarkdown";

const labels: MarkdownLabels = { intro: "Exported on 2026-11-06 from http://host:1", open: "Open at the saved place", missing: "Gone", note: "Note", empty: "Nothing" };
const link = (id: string, view: unknown) => `http://host:1/#book=${id}&view=${encodeURIComponent(JSON.stringify(view))}`;
const item = (extra: Partial<MarkdownItem>): MarkdownItem => ({ bookId: null, view: null, title: "x", comment: "", quote: "", book: null, missing: false, ...extra });

test("a project becomes a title, an intro and a numbered section for each item, in order", () => {
  const md = projectMarkdown(
    { title: "My amplifier", description: "Two stages" },
    [
      item({ bookId: "b1", view: { v: 1, page: 4 }, title: "Schematic", comment: "second stage", book: { name: "Radio.pdf", ext: "pdf" } }),
      item({ bookId: "b2", view: { v: 1 }, title: "Coil table", quote: "turns per layer", book: { name: "Coils.txt", ext: "txt" } }),
      item({ title: "Check the values", comment: "line one\nline two" }),
    ],
    labels,
    link,
  );
  expect(md).toBe(
    [
      "# My amplifier",
      "Two stages",
      "*Exported on 2026-11-06 from http://host:1*",
      "## 1. Schematic",
      "**Radio.pdf** (PDF) — [Open at the saved place](http://host:1/#book=b1&view=%7B%22v%22%3A1%2C%22page%22%3A4%7D)",
      "second stage",
      "## 2. Coil table",
      "**Coils.txt** (TXT) — [Open at the saved place](http://host:1/#book=b2&view=%7B%22v%22%3A1%7D)",
      "> turns per layer",
      "## 3. Check the values",
      "_Note_",
      "line one\nline two",
    ].join("\n\n") + "\n",
  );
});

test("a book that left the library is said so and has no link, but the quote and the comment stay", () => {
  const md = projectMarkdown({ title: "P", description: "" }, [item({ bookId: "b3", title: "Lost", quote: "kept words", comment: "kept note", missing: true })], labels, link);
  expect(md).toContain("_Gone_");
  expect(md).not.toContain("http://host:1/#book");
  expect(md).toContain("> kept words");
  expect(md).toContain("kept note");
});

test("an empty project says so, and a description is left out when there is none", () => {
  const md = projectMarkdown({ title: "Empty", description: "  " }, [], labels, link);
  expect(md).toBe("# Empty\n\n*Exported on 2026-11-06 from http://host:1*\n\n_Nothing_\n");
});

test("characters that mean something in Markdown do not change the title, and a quote of several lines stays a quote", () => {
  const md = projectMarkdown({ title: "R&D [draft] *1*", description: "" }, [item({ bookId: "b4", title: "# not a heading_", quote: "first\n\nsecond", book: { name: "a_b*c.pdf", ext: "pdf" }, view: { note: "(a)" } })], labels, link);
  expect(md).toContain("# R&D \\[draft\\] \\*1\\*");
  expect(md).toContain("## 1. \\# not a heading\\_");
  expect(md).toContain("**a\\_b\\*c.pdf**");
  expect(md).toContain("> first\n>\n> second");
  expect(md).not.toMatch(/\]\([^)]*[()][^)]*\)/); // no parenthesis inside a link address
  expect(md).toContain("%28a%29");
});

test("the file name is the project's title without what a file system refuses", () => {
  expect(markdownFileName("My amplifier")).toBe("My amplifier.md");
  expect(markdownFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j.md");
  expect(markdownFileName("  ..hidden  ")).toBe("hidden.md");
  expect(markdownFileName("///")).toBe("project.md");
  expect(markdownFileName("x".repeat(300)).length).toBe(83);
});
