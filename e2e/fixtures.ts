import { deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";

/** Books for the browser tests, made in code so the repository carries no binary samples. */

const WORDS = "river window mountain quiet engine lantern paper garden winter morning silver bridge harbor letter shadow orchard compass violin market".split(" ");

/** Same text every run. */
function words(seed: number, count: number): string {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(WORDS[x % WORDS.length]!);
  }
  const text = out.join(" ");
  return text[0]!.toUpperCase() + text.slice(1) + ".";
}

export const CHAPTERS = ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"];

export function epub(title: string, hostile = false): Uint8Array {
  const items = CHAPTERS.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = CHAPTERS.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  const nav = CHAPTERS.map((c, i) => `<li><a href="c${i}.xhtml">${c}</a></li>`).join("");
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:${title}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${spine}</spine></package>`),
    "OEBPS/nav.xhtml": strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`),
  };
  CHAPTERS.forEach((c, i) => {
    const evil = hostile && i === 0 ? `<script>try{window.parent.document.title="PWNED"}catch(e){}</script><img src="x" onerror="try{window.parent.document.title='PWNED'}catch(e){}"/><p onclick="alert(1)">clickable</p>` : "";
    const body = Array.from({ length: 12 }, (_, p) => `<p>${words(i * 100 + p, 60)}</p>`).join("");
    files[`OEBPS/c${i}.xhtml`] = strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c}</title></head><body><h1>${c}</h1>${evil}${body}</body></html>`);
  });
  return zipSync(files);
}

export function fb2(): string {
  const sections = CHAPTERS.map((c, i) => `<section><title><p>${c}</p></title>${Array.from({ length: 10 }, (_, p) => `<p>${words(i * 50 + p, 50)}</p>`).join("")}</section>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>prose</genre><author><first-name>Test</first-name><last-name>Author</last-name></author><book-title>A Tale</book-title><lang>en</lang></title-info></description><body><title><p>A Tale</p></title>${sections}</body></FictionBook>`;
}

/** A PDF whose page N says "Page N" and has a bar that grows with N. */
export function pdf(pages: number): Uint8Array {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 48 Tf 80 700 Td (Page ${i + 1}) Tj ET 0.8 0.2 0.2 rg 80 200 ${50 + i * 5} 100 re f`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

export const NOTES_PHRASE = "Тихая гавань и серебряный мост";
export const notes = () => `Заметки\n\n${NOTES_PHRASE}.\n\n${Array.from({ length: 30 }, (_, i) => words(i, 40)).join("\n\n")}`;

export function png(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array {
  const row = new Uint8Array(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y++) raw.set(row, y * row.length);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(strToU8(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (all.set(p, at), (at += p.length));
  return all;
}

export function cbz(): Uint8Array {
  return zipSync({ "page01.png": png(60, 90, [200, 60, 60]), "page02.png": png(60, 90, [60, 160, 80]), "page03.png": png(60, 90, [60, 90, 200]) }, { level: 0 });
}

/** The library most tests start from. */
export function library(): Record<string, Uint8Array | string> {
  return {
    "Books/story.epub": epub("A Story"),
    "Books/hostile.epub": epub("Hostile", true),
    "Books/tale.fb2": fb2(),
    "Docs/pages.pdf": pdf(12),
    "Docs/notes.txt": notes(),
    "Comics/strip.cbz": cbz(),
  };
}

export const PAGE_W = 1000;
export const PAGE_H = 1300;

/** A PDF whose pages are nothing but pictures (JPEG), the way a scanned book is. */
export function scanPdf(pictures: Uint8Array[], w: number, h: number): Uint8Array {
  const parts: (string | Uint8Array)[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (part: string | Uint8Array) => {
    parts.push(part);
    length += typeof part === "string" ? Buffer.byteLength(part, "latin1") : part.length;
  };
  const object = (n: number, body: string | (string | Uint8Array)[]) => {
    offsets[n] = length;
    add(`${n} 0 obj\n`);
    for (const piece of Array.isArray(body) ? body : [body]) add(piece);
    add("\nendobj\n");
  };
  add("%PDF-1.4\n");
  const pageIds = pictures.map((_, i) => 3 + i * 3);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pictures.length} >>`);
  pictures.forEach((jpeg, i) => {
    const page = 3 + i * 3;
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${page + 1} 0 R /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> >>`);
    object(page + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(page + 2, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
  });
  const size = 3 + pictures.length * 3;
  const xref = length;
  add(`xref\n0 ${size}\n0000000000 65535 f \n${Array.from({ length: size - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "latin1") : part;
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** The pictures of scanned pages: each page's lines of text in a big plain font, shot as a browser draws them. */
export async function scanPictures(browser: import("playwright-core").Browser, pages: string[][]): Promise<Uint8Array[]> {
  const shot = await browser.newPage({ viewport: { width: PAGE_W, height: PAGE_H } });
  const pictures: Uint8Array[] = [];
  for (const lines of pages) {
    await shot.setContent(`<body style="margin:0;background:#fff"><div style="font:46px serif;color:#000;padding:120px 60px;line-height:1.6">${lines.map((l) => `<p>${l}</p>`).join("")}</div></body>`);
    pictures.push(new Uint8Array(await shot.screenshot({ type: "jpeg", quality: 92 })));
  }
  await shot.close();
  return pictures;
}

/** A PDF of mixed pages: some are typeset (their lines are text in the file), some are pictures (JPEG), as in a book part of which was scanned. */
export function mixedPdf(pages: ({ lines: string[] } | { picture: Uint8Array })[], w: number, h: number): Uint8Array {
  const parts: (string | Uint8Array)[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (part: string | Uint8Array) => {
    parts.push(part);
    length += typeof part === "string" ? Buffer.byteLength(part, "latin1") : part.length;
  };
  const object = (n: number, body: string | (string | Uint8Array)[]) => {
    offsets[n] = length;
    add(`${n} 0 obj\n`);
    for (const piece of Array.isArray(body) ? body : [body]) add(piece);
    add("\nendobj\n");
  };
  // objects: 1 catalog, 2 page list, 3 font, then each page's own (page, content and, for a picture, the image)
  const ids: number[] = [];
  let next = 4;
  for (const p of pages) {
    ids.push(next);
    next += "picture" in p ? 3 : 2;
  }
  add("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((p, i) => {
    const id = ids[i]!;
    if ("picture" in p) {
      const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
      object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${id + 1} 0 R /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> >>`);
      object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      object(id + 2, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.picture.length} >>\nstream\n`, p.picture, "\nendstream"]);
    } else {
      const content = `BT /F1 36 Tf 80 ${h - 160} Td 60 TL ${p.lines.map((l) => `(${l}) '`).join(" ")} ET`;
      object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${id + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
      object(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
  });
  const size = next;
  const xref = length;
  add(`xref\n0 ${size}\n0000000000 65535 f \n${Array.from({ length: size - 1 }, (_, i) => `${String(offsets[i + 1]).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "latin1") : part;
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
