import { expect, test } from "bun:test";
import { blocksOf, DEFAULT_STYLE, layoutBook, PAGE_FORMATS, pageFormatName, wrapLine, type BookText, type Item, type Measure, type PageFormat } from "./proofPdf";

/** Every character is half its size wide: a font that needs no file, so a line of 10 characters at size 10 is 50 points. */
const measure: Measure = (text, size) => text.length * size * 0.5;

test("a page's text is cut into paragraphs, keeping the line breaks a person typed", () => {
  expect(blocksOf("Первый абзац.\nвторая строка того же.\n\nВторой абзац.")).toEqual([
    { kind: "lines", lines: ["Первый абзац.", "вторая строка того же."] },
    { kind: "lines", lines: ["Второй абзац."] },
  ]);
  expect(blocksOf("a\r\n\r\n\r\nb\r\nc")).toEqual([
    { kind: "lines", lines: ["a"] },
    { kind: "lines", lines: ["b", "c"] },
  ]);
  expect(blocksOf("  \n\n\n")).toEqual([]);
  expect(blocksOf("")).toEqual([]);
});

test("a figure is its own block, wherever it stands in the text", () => {
  expect(blocksOf("Схема.\n\n![Рис. 8.1](images/p008-1.png)\n\nПодпись.")).toEqual([
    { kind: "lines", lines: ["Схема."] },
    { kind: "figure", name: "p008-1.png", alt: "Рис. 8.1" },
    { kind: "lines", lines: ["Подпись."] },
  ]);
  // in the middle of a line, beside text, two in a row, and without a blank line around it
  expect(blocksOf("до ![А](images/p001-1.png) после\n![Б](images/p001-2.png)![В](images/p001-3.png)\nконец")).toEqual([
    { kind: "lines", lines: ["до"] },
    { kind: "figure", name: "p001-1.png", alt: "А" },
    { kind: "lines", lines: ["после"] },
    { kind: "figure", name: "p001-2.png", alt: "Б" },
    { kind: "figure", name: "p001-3.png", alt: "В" },
    { kind: "lines", lines: ["конец"] },
  ]);
  // only the figures of this program: other pictures stay text
  expect(blocksOf("![x](https://example.com/z.png) и ![y](images/other.png)")).toEqual([{ kind: "lines", lines: ["![x](https://example.com/z.png) и ![y](images/other.png)"] }]);
});

test("a line is broken at the spaces, a word wider than the line is broken inside, an empty line stays", () => {
  expect(wrapLine("aaa bbb ccc ddd", 40, 10, measure)).toEqual(["aaa bbb", "ccc ddd"]); // 8 characters fit in 40 points
  expect(wrapLine("  много    пробелов  ", 100, 10, measure)).toEqual(["много пробелов"]);
  expect(wrapLine("abcdefghijkl", 30, 10, measure)).toEqual(["abcdef", "ghijkl"]);
  expect(wrapLine("x abcdefghijkl y", 30, 10, measure)).toEqual(["x", "abcdef", "ghijkl", "y"]); // 6 characters fit; the rest of the long word is a line of its own when the next word does not fit beside it
  expect(wrapLine("x abcdefghijk y", 30, 10, measure)).toEqual(["x", "abcdef", "ghijk", "y"]);
  expect(wrapLine("abcdefghi jk", 40, 10, measure)).toEqual(["abcdefgh", "i jk"]); // the rest of a long word goes on with the next word when they fit
  expect(wrapLine("", 100, 10, measure)).toEqual([""]);
  expect(wrapLine("   ", 100, 10, measure)).toEqual([""]);
  expect(wrapLine("short", 1000, 10, measure)).toEqual(["short"]);
});

const SHEET: PageFormat = { width: 300, height: 300, margin: 20 }; // 260 by 260 points of text
const words = (n: number) => Array.from({ length: n }, (_, i) => `слово${i}`).join(" ");
const book = (over: Partial<BookText> = {}): BookText => ({
  title: "Книга",
  pages: [],
  pageLabel: null,
  figures: new Map(),
  missing: (alt) => `[Рисунок: ${alt}]`,
  ...over,
});
const texts = (items: Item[]) => items.flatMap((i) => (i.kind === "text" ? [i.text] : []));

test("a book with nothing in it is still one sheet with its title", () => {
  const pages = layoutBook(book(), SHEET, measure);
  expect(pages).toHaveLength(1);
  expect(pages[0]!.items).toEqual([{ kind: "text", x: 20, y: 20, text: "Книга", size: DEFAULT_STYLE.title, role: "title" }]);
});

test("the title, the note and the pages go one after another, with a heading for each page when asked", () => {
  const input = book({ note: "Распознано страниц: 1 из 2.", pageLabel: (n) => `Страница ${n}`, pages: [{ page: 1, text: "Один." }, { page: 2, text: "" }, { page: 4, text: "Четыре." }] });
  const [sheet] = layoutBook(input, SHEET, measure);
  expect(sheet!.items.map((i) => (i.kind === "text" ? `${i.role}:${i.text}` : "image"))).toEqual(["title:Книга", "note:Распознано страниц: 1 из 2.", "heading:Страница 1", "body:Один.", "heading:Страница 4", "body:Четыре."]);
  const ys = sheet!.items.map((i) => i.y);
  expect(ys).toEqual([...ys].sort((a, b) => a - b)); // down the sheet, never back up
  expect(new Set(ys).size).toBe(ys.length);
  // without headings the text just follows
  const plain = layoutBook({ ...input, pageLabel: null }, SHEET, measure)[0]!;
  expect(texts(plain.items)).toEqual(["Книга", "Распознано страниц: 1 из 2.", "Один.", "Четыре."]);
});

test("text runs on to a new sheet, every line stays inside the margins, and no sheet is empty", () => {
  const input = book({ pages: [{ page: 1, text: Array.from({ length: 40 }, (_, i) => `Абзац ${i}. ${words(12)}`).join("\n\n") }] });
  const pages = layoutBook(input, SHEET, measure);
  expect(pages.length).toBeGreaterThan(3);
  for (const sheet of pages) {
    expect(sheet.items.length).toBeGreaterThan(0);
    for (const item of sheet.items) {
      if (item.kind !== "text") continue;
      expect(item.x).toBe(20);
      expect(item.y).toBeGreaterThanOrEqual(20);
      expect(item.y + item.size * DEFAULT_STYLE.leading).toBeLessThanOrEqual(280.01);
      expect(measure(item.text, item.size)).toBeLessThanOrEqual(260);
    }
  }
  // nothing is lost or repeated: the words come out in the order they went in
  const all = pages.flatMap((p) => texts(p.items)).slice(1).join(" ").split(" ");
  expect(all.filter((w) => w.startsWith("слово"))).toHaveLength(40 * 12);
  expect(all[1]).toBe("0.");
});

test("a heading is never left alone at the foot of a sheet", () => {
  // the first page is longer by a line each time, so that sooner or later the heading of the second falls at the foot
  let moved = 0;
  for (let n = 1; n <= 25; n++) {
    const first = Array.from({ length: n }, (_, i) => `строка ${i}`).join("\n");
    const pages = layoutBook(book({ pageLabel: (p) => `Страница ${p}`, pages: [{ page: 1, text: first }, { page: 2, text: "Следующая страница." }] }), SHEET, measure);
    for (const sheet of pages) {
      const last = [...sheet.items].reverse().find((i) => i.kind === "text");
      expect(last && last.kind === "text" ? last.role : "").not.toBe("heading");
    }
    if (pages.some((sheet, i) => i > 0 && sheet.items[0]?.kind === "text" && sheet.items[0].role === "heading")) moved++;
  }
  expect(moved).toBeGreaterThan(0); // the case really came up
});

const figures = new Map([
  ["p001-1.png", { width: 1000, height: 500 }], // 360 by 180 points at 200 dpi: wider than the text
  ["p001-2.png", { width: 200, height: 100 }], // 72 by 36 points: small, stays small
  ["p001-3.png", { width: 400, height: 4000 }], // 144 by 1440 points: taller than a sheet
]);

test("a figure is set at its own size for paper, no wider than the text and no taller than a sheet, centred", () => {
  const input = (name: string) => book({ figures, pages: [{ page: 1, text: `![Рис](images/${name})` }] });
  const image = (name: string) => layoutBook(input(name), SHEET, measure).flatMap((p) => p.items).find((i) => i.kind === "image")!;
  const wide = image("p001-1.png");
  expect(wide).toMatchObject({ kind: "image", name: "p001-1.png", width: 260, x: 20 });
  expect(wide.kind === "image" && wide.height).toBeCloseTo(130, 5); // the proportions are kept
  const small = image("p001-2.png");
  expect(small).toMatchObject({ width: 72, height: 36 });
  expect(small.x).toBeCloseTo(20 + (260 - 72) / 2, 5);
  const tall = image("p001-3.png");
  expect(tall.kind === "image" && tall.height).toBeCloseTo(260 - 2 * DEFAULT_STYLE.figureGap, 5);
  expect(tall.kind === "image" && tall.width / tall.height).toBeCloseTo(0.1, 5);
});

test("a figure that does not fit under the text goes to the next sheet whole", () => {
  const filler = Array.from({ length: 9 }, (_, i) => `строка ${i}`).join("\n"); // leaves less than the figure's 130 points
  const pages = layoutBook(book({ figures, pages: [{ page: 1, text: `${filler}\n\n![Рис](images/p001-1.png)\n\nПосле рисунка.` }] }), SHEET, measure);
  expect(pages).toHaveLength(2);
  expect(pages[0]!.items.some((i) => i.kind === "image")).toBe(false);
  const [image] = pages[1]!.items.filter((i) => i.kind === "image");
  expect(image!.y).toBe(20); // at the top of the new sheet, with no gap above
  expect(texts(pages[1]!.items)).toEqual(["После рисунка."]);
  // and one that does fit stays where it is
  const fits = layoutBook(book({ figures, pages: [{ page: 1, text: "Коротко.\n\n![Рис](images/p001-2.png)" }] }), SHEET, measure);
  expect(fits).toHaveLength(1);
});

test("a figure that is not there is told in words where it would have been", () => {
  const pages = layoutBook(book({ pages: [{ page: 1, text: "До.\n\n![Рис. 8.1](images/p008-1.png)\n\nПосле." }] }), SHEET, measure);
  expect(pages[0]!.items.map((i) => (i.kind === "text" ? `${i.role}:${i.text}` : "image"))).toEqual(["title:Книга", "body:До.", "missing:[Рисунок: Рис. 8.1]", "body:После."]);
});

test("the sheets are the same for the same book, and the formats are real paper sizes", () => {
  const input = book({ pageLabel: (n) => `Страница ${n}`, pages: [{ page: 1, text: Array.from({ length: 30 }, (_, i) => `Абзац ${i} ${words(8)}`).join("\n\n") }] });
  expect(layoutBook(input, SHEET, measure)).toEqual(layoutBook(input, SHEET, measure));
  expect(PAGE_FORMATS.a4.width / PAGE_FORMATS.a4.height).toBeCloseTo(210 / 297, 3);
  expect(PAGE_FORMATS.a5.width / PAGE_FORMATS.a5.height).toBeCloseTo(148 / 210, 3);
  expect(pageFormatName("a4")).toBe(true);
  expect(pageFormatName("letter")).toBe(false);
  // a smaller sheet makes more of them
  const a4 = layoutBook(input, PAGE_FORMATS.a4, measure).length;
  const a5 = layoutBook(input, PAGE_FORMATS.a5, measure).length;
  expect(a5).toBeGreaterThan(a4);
});

test("a heading goes to the next sheet together with a figure that does not fit under it", () => {
  const filler = Array.from({ length: 9 }, (_, i) => `строка ${i}`).join("\n");
  const pages = layoutBook(book({ figures, pageLabel: (n) => `Страница ${n}`, pages: [{ page: 1, text: filler }, { page: 2, text: "![Рис](images/p001-1.png)" }] }), SHEET, measure);
  expect(pages).toHaveLength(2);
  expect(pages[1]!.items.map((i) => (i.kind === "text" ? `${i.role}:${i.text}` : "image"))).toEqual(["heading:Страница 2", "image"]);
  expect(pages[0]!.items.some((i) => i.kind === "text" && i.role === "heading" && i.text === "Страница 2")).toBe(false);
});
