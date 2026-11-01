import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { removeDir } from "./testutil";
import { FullText, matchQuery, viewFor } from "./fulltext";
import { Library } from "./library";

let lib: string;
let data: string;
let library: Library;
let libraryDb: ReturnType<typeof openDb>;
let fullText: FullText;
const ids: Record<string, string> = {};

/** A one-page-per-string PDF in Helvetica (Latin text only; real PDFs embed fonts for other scripts). */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((text, i) => {
    const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function makeEpub(chapters: string[]): Uint8Array {
  const items = chapters.map((_, i) => `<item id="c${i}" href="text/c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8(`<package><manifest>${items}</manifest><spine>${spine}</spine></package>`),
  };
  chapters.forEach((c, i) => (files[`OEBPS/text/c${i}.xhtml`] = strToU8(`<html><body><p>${c}</p></body></html>`)));
  return zipSync(files);
}

/** windows-1251 bytes for Cyrillic text. */
const cp1251 = (s: string) => Uint8Array.from([...s].map((c) => (c >= "А" && c <= "я" ? c.charCodeAt(0) - 0x410 + 0xc0 : c === "ё" ? 0xb8 : c.charCodeAt(0))));

beforeAll(async () => {
  lib = mkdtempSync(join(tmpdir(), "reader-ft-lib-"));
  data = mkdtempSync(join(tmpdir(), "reader-ft-data-"));
  mkdirSync(join(lib, "sub"));
  const filler = "lorem ipsum dolor sit amet ".repeat(120);
  writeFileSync(join(lib, "river.txt"), `${filler}\n\nThe harbor lantern glowed over the river.\n\n${filler}`);
  writeFileSync(join(lib, "sub/cafe.txt"), "Café crème and a naïve résumé.");
  writeFileSync(join(lib, "pages.pdf"), makePdf(["First page is about orchards.", "Second page talks about compasses and violins."]));
  writeFileSync(join(lib, "scan.pdf"), makePdf([""]));
  writeFileSync(join(lib, "book.epub"), makeEpub(["Chapter one: quiet mountain.", "Chapter two: silver bridge &amp; the market."]));
  writeFileSync(
    join(lib, "roman.fb2"),
    Buffer.concat([cp1251('<?xml version="1.0" encoding="windows-1251"?><FictionBook><body><section><p>Тихая гавань и серебряный мост.</p></section></body><binary id="x">AAAA</binary></FictionBook>')]),
  );
  writeFileSync(join(lib, "broken.epub"), "this is not a zip");
  writeFileSync(join(lib, "comic.cbz"), "not indexed at all");
  const config = new ConfigStore(data);
  libraryDb = openDb(data);
  library = new Library(libraryDb, config, data);
  await library.setRoot(lib);
  for (const b of library.books()) ids[b.name] = b.id;
  fullText = new FullText(data, library, config, 0);
});
afterAll(async () => {
  await fullText.close();
  library.close();
  libraryDb.close();
  removeDir(lib);
  removeDir(data);
});

async function settled(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const s = fullText.status();
    if (s.indexed + s.skipped + s.failed >= s.total && !s.working) return;
    await Bun.sleep(50);
  }
  throw new Error("indexing did not finish");
}

test("nothing is indexed or searchable until the administrator turns it on", async () => {
  expect(fullText.enabled).toBe(false);
  expect(fullText.search("harbor")).toEqual([]);
  expect(fullText.status()).toMatchObject({ enabled: false, indexed: 0, total: 7 }); // the comic has nothing to index
});

test("every format is read, scans and broken files are set aside, not retried", async () => {
  fullText.setEnabled(true);
  await settled();
  expect(fullText.status()).toMatchObject({ enabled: true, total: 7, indexed: 5, skipped: 1, failed: 1, working: null });
});

test("a plain-text hit opens the file at the word, marked", () => {
  const [hit] = fullText.search("harbor lantern");
  expect(hit!.id).toBe(ids.river!);
  const view = hit!.hits[0]!.view as { offset: number; range: [number, number] };
  const text = Bun.file(join(lib, "river.txt"));
  return text.text().then((t) => {
    expect(t.slice(view.range[0], view.range[1]).toLowerCase()).toBe("harbor");
    expect(hit!.hits[0]!.snippet).toContain("\u0001harbor\u0002");
  });
});

test("a PDF hit names the page, an EPUB hit its spine item (counted from 0)", () => {
  expect(fullText.search("compasses")[0]).toMatchObject({ id: ids.pages!, hits: [{ view: { v: 1, page: 2 } }] });
  expect(fullText.search("silver bridge")[0]).toMatchObject({ id: ids.book!, hits: [{ view: { v: 1, section: 1 } }] });
});

test("windows-1251 FB2 is read, and a word's beginning is enough", () => {
  const found = fullText.search("серебр");
  expect(found[0]).toMatchObject({ id: ids.roman! });
  expect((found[0]!.hits[0]!.view as { fraction: number }).fraction).toBe(0);
});

test("accents and case do not matter", () => {
  expect(fullText.search("CAFE creme naive")[0]!.id).toBe(ids.cafe!);
  expect(fullText.search("résumé")[0]!.id).toBe(ids.cafe!);
});

test("books that are not in the library are never returned, and junk queries are harmless", () => {
  expect(fullText.search("zzzzzz")).toEqual([]);
  expect(fullText.search("   ")).toEqual([]);
  expect(fullText.search('"; DROP TABLE chunks; --')).toEqual([]);
  expect(fullText.search("*")).toEqual([]);
});

test("the index is dropped when asked, and rebuilt while search stays on", async () => {
  await fullText.clear();
  await settled();
  expect(fullText.status()).toMatchObject({ indexed: 5 });
  expect(fullText.search("orchards")).toHaveLength(1);
});

test("turning it off stops searching but keeps the index for later", async () => {
  fullText.setEnabled(false);
  expect(fullText.search("orchards")).toEqual([]);
  fullText.setEnabled(true);
  expect(fullText.search("orchards")).toHaveLength(1);
});

test("query building and views", () => {
  expect(matchQuery("Hello, wörld! x")).toEqual({ match: '"hello" "wörld" "x"*', words: ["hello", "wörld", "x"] });
  expect(matchQuery("!!!")).toBeNull();
  expect(viewFor("ecatm", { image: 3, link: 9 })).toEqual({ v: 1, imageId: 3, linkId: 9 });
  expect(viewFor("mobi", { fraction: 0.123456 })).toEqual({ v: 1, fraction: 0.1235 });
});
