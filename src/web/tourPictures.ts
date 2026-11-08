import { lang as currentLang, t, type Lang } from "./i18n";

/**
 * Small pictures for the longer explanations of the quick tours. They are drawn here as SVG (no files to ship),
 * use the colours of the current theme through CSS classes, and say their words in the language of the interface,
 * with the very words of the buttons they show.
 */
export type TourPicture =
  | "panel"
  | "tree"
  | "search"
  | "tags"
  | "signin"
  | "bookmarks"
  | "flow"
  | "links"
  | "edit"
  | "link"
  | "settings"
  | "theme"
  | "lang"
  | "title"
  | "card"
  | "print"
  | "mark"
  | "reader"
  | "share"
  | "toolbar"
  | "help"
  | "item"
  | "thumb"
  | "tools"
  | "rename"
  | "export"
  | "printProject"
  | "note";

const NS = "http://www.w3.org/2000/svg";
const WIDTH = 320;

type Attrs = Record<string, string | number>;
type Part = SVGElement | Part[];

const flat = (parts: Part[]): SVGElement[] => parts.flatMap((part) => (Array.isArray(part) ? flat(part) : [part]));

function node(tag: string, attrs: Attrs, ...children: (SVGElement | string)[]): SVGElement {
  const made = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) made.setAttribute(name, String(value));
  for (const child of children) made.append(child);
  return made;
}

/** A rounded frame; `extra` adds CSS classes (tp-hot lights it up, tp-item fills it grey, tp-primary fills it with the accent). */
const box = (x: number, y: number, w: number, h: number, extra = "") => node("rect", { x, y, width: w, height: h, rx: 6, class: `tp-box ${extra}`.trim() });
const text = (x: number, y: number, words: string, extra = "", anchor = "start") => node("text", { x, y, class: `tp-text ${extra}`.trim(), "text-anchor": anchor }, words);
const down = (x: number, y1: number, y2: number) => node("path", { d: `M${x} ${y1} V${y2 - 3} M${x - 4} ${y2 - 8} L${x} ${y2 - 2} L${x + 4} ${y2 - 8}`, class: "tp-arrow" });
const right = (y: number, x1: number, x2: number) => node("path", { d: `M${x1} ${y} H${x2 - 3} M${x2 - 8} ${y - 4} L${x2 - 2} ${y} L${x2 - 8} ${y + 4}`, class: "tp-arrow" });
const bar = (x: number, y: number, w: number) => node("rect", { x, y, width: w, height: 5, rx: 2, class: "tp-item" }); // a line of text, greyed out
const lines = (x: number, y: number, w: number, n: number, gap = 9): SVGElement[] => Array.from({ length: n }, (_, i) => bar(x, y + i * gap, i === n - 1 ? w * 0.6 : w));

/** A button with words in it; its width follows the words. Returns the parts and the x where the next one may start. */
function chip(x: number, y: number, words: string, hot = false, min = 22): { parts: SVGElement[]; end: number } {
  const w = Math.max(min, Math.round(words.length * 6.9 + 18));
  return { parts: [box(x, y, w, 22, hot ? "tp-hot" : ""), text(x + w / 2, y + 15, words, hot ? "tp-hot-text" : "", "middle")], end: x + w + 6 };
}
function row(x: number, y: number, words: string[], hotAt: number[] = []): { parts: SVGElement[]; end: number } {
  const parts: SVGElement[] = [];
  let at = x;
  words.forEach((word, i) => {
    const made = chip(at, y, word, hotAt.includes(i));
    parts.push(...made.parts);
    at = made.end;
  });
  return { parts, end: at };
}
const badge = (x: number, y: number, words: string, fill: string) => [node("rect", { x, y, width: words.length * 6 + 8, height: 12, rx: 3, style: `fill:${fill}` }), text(x + (words.length * 6 + 8) / 2, y + 9, words, "tp-badge", "middle")];
const PDF = "#c0392b";
const TXT = "#6b7280";

function svg(height: number, alt: string, ...children: Part[]): SVGElement {
  return node("svg", { viewBox: `0 0 ${WIDTH} ${height}`, class: "tour-pic", role: "img", "aria-label": alt }, node("title", {}, alt), ...flat(children));
}

/** The reader's top bar: format badge, name, and the buttons that are drawn. */
function readerBar(y: number, buttons: string[], hotAt: number[] = []): Part[] {
  const widths = buttons.map((b) => Math.max(22, Math.round(b.length * 6.9 + 18)) + 6);
  const total = widths.reduce((a, b) => a + b, 0);
  const placed = row(WIDTH - 8 - total + 6, y + 4, buttons, hotAt);
  return [box(4, y, 312, 30), badge(12, y + 9, "TXT", TXT), text(46, y + 19, "notes", "tp-bold"), placed.parts];
}

/* ---------- the library ---------- */

function panel(alt: string): SVGElement {
  return svg(
    150,
    alt,
    box(4, 4, 312, 142),
    chip(10, 9, "☰", true).parts,
    box(46, 9, 150, 22),
    text(54, 24, t("search.placeholder"), "tp-muted"),
    box(4, 36, 100, 110, "tp-item"),
    text(14, 56, "▸ Books"),
    text(14, 74, "▸ Comics"),
    text(14, 92, "▾ Docs"),
    text(26, 110, "pages"),
    text(26, 126, "notes"),
    text(116, 56, t("shelf.root"), "tp-bold"),
    [0, 1, 2, 3].map((i) => box(116 + i * 48, 66, 40, 60)),
  );
}

function tree(alt: string): SVGElement {
  return svg(
    150,
    alt,
    box(4, 4, 130, 142),
    text(14, 24, "▸ Books"),
    text(110, 24, "3", "tp-muted", "end"),
    text(14, 44, "▾ Docs"),
    text(110, 44, "2", "tp-muted", "end"),
    box(18, 52, 108, 22, "tp-hot"),
    badge(24, 57, "PDF", PDF),
    text(62, 67, "pages"),
    badge(24, 82, "TXT", TXT),
    text(62, 92, "notes"),
    right(63, 128, 160),
    box(164, 4, 152, 142),
    lines(176, 22, 128, 5),
    box(176, 74, 128, 50, "tp-item"),
    lines(176, 134, 100, 1),
  );
}

function search(alt: string): SVGElement {
  return svg(
    170,
    alt,
    box(10, 6, 300, 24, "tp-hot"),
    text(20, 22, "detector"),
    box(10, 34, 300, 130),
    badge(20, 44, "PDF", PDF),
    text(58, 54, "Docs / detector receiver"),
    badge(20, 66, "TXT", TXT),
    text(58, 76, "Docs / detector notes"),
    text(20, 100, t("search.inContents"), "tp-bold"),
    text(20, 118, "…a detector with a crystal and a coil…", "tp-muted"),
    text(20, 136, "…the detector stage needs no power…", "tp-muted"),
  );
}

function tags(alt: string): SVGElement {
  const chips = row(16, 28, ["radio 3", "circuits 2", "lamps 1"], [0, 1]);
  const shelfCard = (x: number, name: string) => [box(x, 84, 84, 66), box(x + 8, 92, 68, 36, "tp-item"), text(x + 8, 144, name, "tp-bold")];
  return svg(
    160,
    alt,
    box(4, 4, 312, 152),
    text(16, 22, t("tags.title"), "tp-muted"),
    chips.parts,
    text(16, 74, t("tags.found", { n: 2 }), "tp-muted"),
    shelfCard(16, "pages"),
    shelfCard(112, "notes"),
  );
}

function signin(alt: string): SVGElement {
  return svg(
    150,
    alt,
    box(4, 4, 312, 30),
    chip(222, 8, t("account.signIn"), true, 88).parts,
    down(266, 34, 56),
    box(70, 56, 240, 90),
    text(82, 74, t("account.signIn"), "tp-bold"),
    box(82, 82, 216, 20),
    text(90, 96, "Alex"),
    box(82, 108, 216, 20),
    text(90, 122, "••••••"),
  );
}

function bookmarks(alt: string): SVGElement {
  const rows: [string, string, string][] = [
    [t("bookmark.page", { n: 4 }), "Radio", "PDF"],
    [t("bookmark.page", { n: 12 }), "Coils", "PDF"],
    [t("bookmark.page", { n: 1 }), "Story", "EPUB"],
  ];
  return svg(
    160,
    alt,
    box(4, 4, 312, 30),
    chip(196, 8, `★ ${t("account.bookmarks")}`, true).parts,
    down(250, 34, 52),
    box(40, 52, 276, 104),
    text(52, 70, t("bookmark.title"), "tp-bold"),
    rows.map(([place, book, format], i) => [text(52, 92 + i * 22, `★ ${place}`, "tp-bold"), text(150, 92 + i * 22, book, "tp-muted"), badge(250, 83 + i * 22, format, format === "EPUB" ? "#2459d6" : PDF)]),
  );
}

function links(alt: string): SVGElement {
  return svg(
    140,
    alt,
    box(4, 4, 312, 132),
    text(16, 24, t("account.links"), "tp-bold"),
    text(16, 50, "Radio"),
    text(16, 64, t("share.expiresOn", { date: "30.11" }), "tp-muted"),
    chip(210, 40, t("share.revoke"), true, 96).parts,
    text(16, 96, "Coils"),
    text(16, 110, t("share.noLimit"), "tp-muted"),
    chip(210, 86, t("share.revoke"), false, 96).parts,
  );
}

function edit(alt: string): SVGElement {
  return svg(
    170,
    alt,
    chip(8, 6, `✎ ${t("edit.start")}`, true).parts,
    box(8, 36, 150, 126),
    text(18, 56, "▸ Books"),
    box(18, 64, 130, 22, "tp-hot"),
    text(26, 79, "▾ Docs"),
    text(36, 104, "pages"),
    text(36, 124, "notes"),
    box(172, 40, 80, 22, "tp-primary"),
    text(212, 55, "pages", "tp-primary-text", "middle"),
    node("path", { d: "M172 51 C 120 20, 110 60, 150 70", class: "tp-arrow", style: "stroke-dasharray:4 3" }),
    row(172, 78, [`✎ ${t("edit.rename")}`]).parts,
    row(172, 106, [`⇄ ${t("edit.move")}`]).parts,
    row(172, 134, [`＋ ${t("edit.newFolderButton")}`]).parts,
  );
}

function link(alt: string): SVGElement {
  return svg(
    180,
    alt,
    box(4, 4, 312, 172),
    text(16, 24, t("link.title"), "tp-bold"),
    text(16, 42, t("link.linkLabel"), "tp-muted"),
    box(16, 48, 288, 22),
    text(24, 63, "https://drive.example/detector.pdf"),
    chip(16, 78, t("link.check"), false).parts,
    down(160, 100, 118),
    badge(16, 124, "PDF", PDF),
    text(54, 134, "detector"),
    text(130, 134, `${t("link.folder")}: Docs`, "tp-muted"),
    chip(210, 142, t("link.download"), true, 94).parts,
    box(16, 148, 150, 20, "tp-item"),
    text(24, 162, "Docs / detector.pdf", "tp-muted"),
  );
}

function settings(alt: string): SVGElement {
  const rows = [t("admin.library"), t("admin.access"), t("admin.internet"), t("backup.title"), t("admin.stop")];
  return svg(
    170,
    alt,
    box(4, 4, 312, 162),
    text(16, 24, t("admin.title"), "tp-bold"),
    rows.map((name, i) => [box(16, 32 + i * 26, 288, 22, i === 4 ? "tp-hot" : ""), text(26, 47 + i * 26, name), text(294, 47 + i * 26, "▸", "tp-muted", "end")]),
  );
}

function theme(alt: string): SVGElement {
  const swatch = (x: number, fill: string, ink: string, name: string, hot: boolean) => [
    node("rect", { x, y: 8, width: 92, height: 56, rx: 6, class: `tp-box ${hot ? "tp-hot" : ""}`, style: `fill:${fill}` }),
    node("rect", { x: x + 10, y: 20, width: 52, height: 5, rx: 2, style: `fill:${ink}` }),
    node("rect", { x: x + 10, y: 32, width: 72, height: 5, rx: 2, style: `fill:${ink};opacity:.5` }),
    node("rect", { x: x + 10, y: 44, width: 40, height: 5, rx: 2, style: `fill:${ink};opacity:.5` }),
    text(x + 46, 82, name, "", "middle"),
  ];
  return svg(92, alt, swatch(10, "#ffffff", "#222222", t("theme.light"), false), swatch(114, "#1b1e24", "#e6e6e6", t("theme.dark"), false), swatch(218, "#ffffff", "#222222", t("theme.auto"), true), node("path", { d: "M264 8 H310 V64 H264 Z", style: "fill:#1b1e24" }));
}

function lang(alt: string): SVGElement {
  const names: [Lang, string, string][] = [
    ["en", "English", "Library"],
    ["ru", "Русский", "Библиотека"],
    ["uk", "Українська", "Бібліотека"],
  ];
  return svg(
    60,
    alt,
    names.map(([code, name, library], i) => [chip(10 + i * 102, 6, name, code === currentLang(), 94).parts, text(10 + i * 102, 52, library, "tp-bold")]),
  );
}

/* ---------- the reader ---------- */

function title(alt: string): SVGElement {
  return svg(
    120,
    alt,
    box(4, 4, 312, 30),
    badge(12, 13, "TXT", TXT),
    text(46, 23, "notes", "tp-bold"),
    text(92, 23, "Docs/notes.txt", "tp-muted"),
    down(60, 34, 56),
    text(60, 70, `${t("shelf.root")} › Docs › notes`, "", "start"),
    box(4, 80, 312, 34, "tp-item"),
    lines(14, 90, 292, 2),
  );
}

function card(alt: string): SVGElement {
  const reset = `↺ ${t("card.reset")}`;
  const resetWidth = Math.round(reset.length * 6.9 + 18);
  const field = (y: number, x: number, w: number, label: string, value: string) => [text(x, y, label, "tp-muted"), box(x, y + 4, w, 18), text(x + 6, y + 17, value)];
  return svg(
    196,
    alt,
    box(4, 4, 312, 188),
    text(16, 24, t("card.title"), "tp-bold"),
    field(42, 16, 288, t("card.titleField"), "Detector radio"),
    field(76, 16, 288, t("card.authors"), "I. G. Belyaev"),
    field(110, 16, 64, t("card.year"), "1949"),
    field(110, 96, 208, t("card.tags"), "radio, circuits"),
    text(16, 156, t("card.inFile", { value: "Radio" }), "tp-muted"),
    chip(304 - resetWidth, 142, reset, true).parts,
    chip(16, 164, t("common.save")).parts,
  );
}

function print(alt: string): SVGElement {
  return svg(
    200,
    alt,
    box(4, 4, 312, 142),
    text(16, 24, t("print.title"), "tp-bold"),
    text(16, 46, `◉ ${t("print.allPages", { n: 12 })}`),
    text(16, 66, `○ ${t("print.thisPage", { n: 5 })}`),
    text(16, 86, `○ ${t("print.pages")}`),
    box(110, 74, 34, 16),
    text(127, 86, "3", "", "middle"),
    text(156, 86, t("print.to")),
    box(180, 74, 34, 16),
    text(197, 86, "5", "", "middle"),
    chip(230, 116, t("print.go"), true, 74).parts,
    down(267, 138, 156),
    box(110, 156, 206, 38, "tp-item"),
    text(213, 179, "PDF", "tp-bold", "middle"),
  );
}

function mark(alt: string): SVGElement {
  return svg(
    182,
    alt,
    readerBar(4, [`★ ${t("bookmark.title")}`], [0]),
    down(262, 34, 52),
    box(40, 52, 276, 126),
    text(52, 70, t("bookmark.title"), "tp-bold"),
    box(52, 78, 252, 20),
    text(60, 92, t("bookmark.page", { n: 5 })),
    chip(52, 104, t("bookmark.add"), true).parts,
    text(52, 148, `★ ${t("bookmark.page", { n: 4 })}`, "tp-bold"),
    text(52, 166, `★ ${t("bookmark.page", { n: 12 })}`, "tp-bold"),
  );
}

function reader(alt: string): SVGElement {
  return svg(
    208,
    alt,
    box(4, 4, 312, 30),
    text(14, 23, "Radio.pdf", "tp-bold"),
    chip(196, 8, `＋ ${t("projects.add")}`, true, 114).parts,
    down(253, 34, 56),
    box(40, 56, 276, 146),
    text(52, 75, t("projects.addTitle"), "tp-bold"),
    box(52, 83, 252, 20),
    text(60, 97, `${t("tourpic.example")} ▾`),
    box(52, 108, 252, 20),
    text(60, 122, `${t("projects.itemTitle")}: ${t("tourpic.page").split(" +")[0]!}`),
    box(52, 133, 252, 30),
    text(60, 147, t("projects.comment"), "tp-muted"),
    box(52, 170, 80, 22, "tp-primary"),
    text(92, 185, t("tourpic.add"), "tp-primary-text", "middle"),
  );
}

function share(alt: string): SVGElement {
  // a QR-looking square: three finder marks and a scatter of cells
  const cells: SVGElement[] = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const finder = (r < 3 && c < 3) || (r < 3 && c > 5) || (r > 5 && c < 3);
      if (finder ? !(r % 3 === 1 && c % 3 === 1) : (r * 7 + c * 5 + r * c) % 3 === 0) cells.push(node("rect", { x: 236 + c * 7, y: 40 + r * 7, width: 6, height: 6, class: "tp-ink" }));
    }
  }
  return svg(
    172,
    alt,
    box(4, 4, 312, 164),
    text(16, 24, t("share.button"), "tp-bold"),
    text(16, 46, `◉ ${t("share.exact").slice(0, 25)}…`),
    text(16, 66, `○ ${t("share.start")}`),
    text(16, 92, t("share.expires"), "tp-muted"),
    box(16, 98, 100, 20),
    text(24, 112, t("share.days", { n: 7 })),
    cells,
    text(268, 118, t("share.qr"), "tp-muted", "middle"),
    chip(16, 140, t("share.create"), true).parts,
  );
}

function toolbar(alt: string): SVGElement {
  return svg(
    120,
    alt,
    box(4, 4, 312, 78),
    row(10, 9, ["‹", `${t("pdf.page")} 5 / 12`, "›", "−", "+"]).parts,
    row(10, 33, [t("pdf.fitWidth"), t("pdf.fitPage"), `⟳ ${t("pdf.turn")}`], []).parts,
    row(10, 57, [`✂ ${t("pdf.crop")}`, "№", t("pdf.area")]).parts,
    text(10, 106, "PDF: …  EPUB / TXT:  A−  A+  ☰  " + t("book.mark"), "tp-muted"),
  );
}

function help(alt: string): SVGElement {
  return svg(
    130,
    alt,
    readerBar(4, ["?"], [0]),
    down(298, 34, 52),
    box(60, 52, 256, 72),
    text(72, 70, t("tour.step", { n: 1, total: 7 }), "tp-muted"),
    text(304, 70, t("tour.skip"), "tp-muted", "end"),
    lines(72, 82, 232, 2),
    chip(222, 96, t("tour.next"), true, 82).parts,
  );
}

/* ---------- the screen of a project ---------- */

function item(alt: string): SVGElement {
  return svg(
    170,
    alt,
    box(4, 4, 196, 162),
    text(14, 24, t("tourpic.sample"), "tp-hot-text"),
    text(14, 40, "pages", "tp-muted"),
    badge(48, 31, "PDF", PDF),
    node("rect", { x: 14, y: 48, width: 58, height: 70, rx: 3, style: "fill:#c93a3a" }),
    text(14, 138, t("tourpic.sampleComment")),
    text(14, 156, "↑ ↓ ✎ ×", "tp-muted"),
    right(80, 202, 230),
    box(232, 24, 84, 118),
    lines(240, 38, 68, 3),
    node("rect", { x: 240, y: 70, width: 40, height: 22, rx: 2, style: "fill:#c93a3a" }),
    text(316, 160, t("tourpic.page"), "tp-muted", "end"),
  );
}

function thumb(alt: string): SVGElement {
  return svg(
    170,
    alt,
    box(14, 8, 100, 142),
    lines(24, 22, 80, 3),
    node("rect", { x: 28, y: 92, width: 36, height: 24, rx: 2, style: "fill:#c93a3a" }),
    node("rect", { x: 24, y: 86, width: 46, height: 36, rx: 2, class: "tp-region" }),
    text(64, 164, t("tourpic.page"), "tp-muted", "middle"),
    right(104, 118, 168),
    node("rect", { x: 172, y: 78, width: 100, height: 52, rx: 3, style: "fill:#fff;stroke:#bbb" }),
    node("rect", { x: 200, y: 94, width: 44, height: 22, rx: 2, style: "fill:#c93a3a" }),
    text(222, 146, t("tourpic.area"), "tp-muted", "middle"),
    text(222, 20, t("tourpic.noArea"), "tp-muted", "middle"),
  );
}

function tools(alt: string): SVGElement {
  const buttons: [string, string][] = [
    ["↑", t("projects.up")],
    ["↓", t("projects.down")],
    ["✎", t("projects.edit")],
    ["×", t("common.delete")],
  ];
  return svg(
    90,
    alt,
    buttons.map(([sign, name], i) => [box(12 + i * 76, 10, 34, 30, i === 3 ? "tp-hot" : ""), text(29 + i * 76, 31, sign, "tp-bold", "middle"), text(29 + i * 76, 58, name, "tp-muted", "middle")]),
    text(160, 80, t("tourpic.asks"), "tp-muted", "middle"),
  );
}

function rename(alt: string): SVGElement {
  return svg(
    150,
    alt,
    box(4, 4, 312, 142),
    box(16, 14, 288, 22, "tp-hot"),
    text(24, 29, t("tourpic.example"), "tp-bold"),
    box(16, 44, 288, 44),
    text(24, 60, t("projects.description"), "tp-muted"),
    chip(16, 100, t("common.save"), true, 80).parts,
    chip(100, 100, t("common.cancel"), false, 80).parts,
  );
}

function exportFile(alt: string): SVGElement {
  return svg(
    190,
    alt,
    chip(10, 6, `⤓ ${t("projects.exportButton")}`, true).parts,
    down(60, 28, 48),
    box(10, 48, 300, 136),
    text(20, 66, `# ${t("tourpic.example")}`, "tp-mono tp-bold"),
    text(20, 86, `## 1. ${t("tourpic.sample").slice(0, 26)}`, "tp-mono tp-bold"),
    text(20, 104, "**pages** (PDF) — [↗](http://…)", "tp-mono"),
    text(20, 122, "> …", "tp-mono tp-muted"),
    text(20, 140, t("tourpic.sampleComment").slice(0, 36), "tp-mono"),
    text(20, 164, "*http://…:8000*", "tp-mono tp-muted"),
  );
}

function printProject(alt: string): SVGElement {
  return svg(
    200,
    alt,
    chip(10, 6, `🖶 ${t("projects.printButton")}`, true).parts,
    down(60, 28, 48),
    node("rect", { x: 40, y: 48, width: 240, height: 148, rx: 3, style: "fill:#fff;stroke:#bbb" }),
    text(52, 68, t("tourpic.example"), "tp-ink-text tp-bold"),
    node("rect", { x: 52, y: 78, width: 56, height: 36, rx: 2, style: "fill:#c93a3a" }),
    node("rect", { x: 116, y: 82, width: 150, height: 5, rx: 2, style: "fill:#999" }),
    node("rect", { x: 116, y: 94, width: 120, height: 5, rx: 2, style: "fill:#bbb" }),
    node("rect", { x: 52, y: 126, width: 3, height: 22, style: "fill:#999" }),
    node("rect", { x: 62, y: 130, width: 190, height: 5, rx: 2, style: "fill:#999" }),
    node("rect", { x: 62, y: 142, width: 150, height: 5, rx: 2, style: "fill:#bbb" }),
    node("rect", { x: 52, y: 160, width: 214, height: 5, rx: 2, style: "fill:#bbb" }),
    node("rect", { x: 52, y: 172, width: 140, height: 5, rx: 2, style: "fill:#bbb" }),
  );
}

function note(alt: string): SVGElement {
  return svg(
    190,
    alt,
    box(4, 4, 312, 112),
    text(16, 22, t("projects.noteTitle"), "tp-bold"),
    box(16, 30, 288, 20),
    text(24, 44, t("tourpic.noteSample")),
    box(16, 56, 288, 26),
    text(24, 72, t("projects.comment"), "tp-muted"),
    chip(16, 88, t("projects.addNote"), true, 90).parts,
    down(160, 116, 136),
    box(4, 136, 312, 50, "tp-item"),
    text(14, 156, t("tourpic.noteSample"), "tp-bold"),
    text(14, 174, t("projects.ownNote"), "tp-muted"),
  );
}

/** The long explanation of a project and where its places come from: books on top, the project, the files it can become. */
function flow(alt: string): SVGElement {
  return svg(
    226,
    alt,
    box(10, 4, 300, 40),
    text(160, 29, t("tourpic.books"), "", "middle"),
    down(100, 44, 74),
    text(112, 63, `＋ ${t("projects.add")}`, "tp-hot-text"),
    box(10, 74, 300, 82, "tp-hot"),
    text(22, 94, t("projects.project"), "tp-bold"),
    box(22, 102, 276, 14, "tp-item"),
    text(30, 113, `▭ ${t("tourpic.page")}`),
    box(22, 120, 276, 14, "tp-item"),
    text(30, 131, `❝ ${t("tourpic.quote")}`),
    box(22, 138, 276, 14, "tp-item"),
    text(30, 149, `✎ ${t("tourpic.note")}`),
    down(100, 156, 184),
    text(112, 174, `⤓ 🖶  ${t("tourpic.output")}`, "tp-muted"),
    box(10, 184, 300, 36),
    text(160, 207, t("tourpic.files"), "", "middle"),
  );
}

const DRAW: Record<TourPicture, (alt: string) => SVGElement> = { panel, tree, search, tags, signin, bookmarks, flow, links, edit, link, settings, theme, lang, title, card, print, mark, reader, share, toolbar, help, item, thumb, tools, rename, export: exportFile, printProject, note };

/** `alt` says in words what the picture shows; the tour passes the text of the step. */
export const tourPicture = (which: TourPicture, alt: string): SVGElement => DRAW[which](alt);

