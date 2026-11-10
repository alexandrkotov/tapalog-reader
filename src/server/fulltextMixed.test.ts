import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { FullText } from "./fulltext";
import { Library } from "./library";
import { removeDir } from "./testutil";

let lib: string;
let data: string;
let library: Library;
let libraryDb: ReturnType<typeof openDb>;
let fullText: FullText;

/** A PDF with one string per page (Latin text; an empty string is a page with nothing to read). */
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

/** `text` pages with a sentence each, then `blank` pages with nothing, then `stamp` pages that only carry a number. */
const book = (text: number, blank: number, stamp = 0) => makePdf([...Array.from({ length: text }, (_, i) => `Page ${i + 1} explains how the amplifier is wired`), ...Array.from({ length: blank }, () => ""), ...Array.from({ length: stamp }, (_, i) => `${i + 1}`)]);

beforeAll(async () => {
  lib = mkdtempSync(join(tmpdir(), "reader-mixed-lib-"));
  data = mkdtempSync(join(tmpdir(), "reader-mixed-data-"));
  // enough typeset text in all (over 2000 characters), so only the pages without text can make a book count as a scan
  writeFileSync(join(lib, "mixed.pdf"), book(60, 8)); // 8 of 68 pages are pictures
  writeFileSync(join(lib, "stamps.pdf"), book(60, 0, 7)); // 7 of 67 pages carry only a number: those count as pictures too
  writeFileSync(join(lib, "text.pdf"), book(60, 2)); // 2 blank pages (a cover, a flyleaf) are not worth the offer
  writeFileSync(join(lib, "long.pdf"), book(60, 3)); // 3 of 63: enough pages, but under a tenth of the book
  const config = new ConfigStore(data);
  libraryDb = openDb(data);
  library = new Library(libraryDb, config, data);
  await library.setRoot(lib);
  fullText = new FullText(data, library, config, 0);
  fullText.setEnabled(true);
  await settled();
}, 60_000);
afterAll(async () => {
  await fullText.close();
  library.close();
  libraryDb.close();
  removeDir(lib);
  removeDir(data);
});

async function settled(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const s = fullText.status();
    if (s.indexed + s.skipped + s.failed >= s.total && s.total > 0 && !s.working) return;
    await Bun.sleep(50);
  }
  throw new Error("indexing did not finish");
}

const offered = () => Object.fromEntries(fullText.scans().map((s) => [s.book.name, { pages: s.pages, textPages: s.textPages }]));

test("a PDF that has a share of pages without text is offered for recognizing, with its page count; the others are not", () => {
  expect(offered()).toEqual({ mixed: { pages: 68, textPages: 60 }, stamps: { pages: 67, textPages: 60 } });
});

test("the books indexed before pages were counted are measured later, without touching their text in the search", async () => {
  const db = (fullText as unknown as { db: import("bun:sqlite").Database }).db;
  db.run("UPDATE docs SET pages = NULL, textpages = NULL");
  expect(offered()).toEqual({}); // nothing is known of the pages now, and the books have text
  expect(fullText.search("amplifier")).toHaveLength(4);
  fullText.kick();
  for (let i = 0; i < 200 && (db.query("SELECT COUNT(*) AS n FROM docs WHERE pages IS NULL").get() as { n: number }).n > 0; i++) await Bun.sleep(50);
  await settled();
  expect(offered()).toEqual({ mixed: { pages: 68, textPages: 60 }, stamps: { pages: 67, textPages: 60 } });
  expect(fullText.search("amplifier")).toHaveLength(4); // the index was not emptied on the way
}, 30_000);
