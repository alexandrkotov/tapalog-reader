import { expect, test } from "bun:test";
import { chunkText } from "./extract";
import { decodeEntities, htmlToText } from "./html";
import { decompressPalmDoc, mobiText } from "./mobi";

test("html is reduced to its visible text", () => {
  const html = `<html><head><title>x</title><style>p{color:red}</style></head><body><h1>Title</h1><p>One &amp; two&nbsp;three&#33; &#x41;</p><script>alert(1)</script><p>Next<br/>line</p><binary id="a">AAAA</binary></body></html>`;
  expect(htmlToText(html)).toBe("Title\nOne & two three! A\nNext\nline");
  expect(decodeEntities("&unknown; &#xD800000;")).toBe("&unknown; ");
});

test("chunks cut at whitespace, keep their start offsets and cover the whole text", () => {
  const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkText(text, 200);
  expect(chunks.length).toBeGreaterThan(5);
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(200);
    expect(text.slice(c.start, c.start + c.text.length)).toBe(c.text);
  }
  expect(chunks.map((c) => c.text).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
});

test("PalmDOC compression: literals, copies, length-distance pairs and space+letter", () => {
  // "hello hello" = literals "hello " then a pair copying 5 bytes from 6 back, then " " + 'w' packed as 0xF7
  const packed = Uint8Array.from([...new TextEncoder().encode("hello "), 0x80 | (6 >> 5), ((6 << 3) & 0xff) | 2, 0xf7]);
  // pair: 10dddddd dddddlll, distance 6, length 5 (lll = 2)
  expect(new TextDecoder().decode(decompressPalmDoc(packed))).toBe("hello hello w");
  expect(new TextDecoder().decode(decompressPalmDoc(Uint8Array.from([2, 0xd0, 0x96])))).toBe("Ж"); // "copy the next 2 bytes"
});

/** A minimal MOBI 6 file whose text is `html`, in records of 4 KiB. */
function makeMobi(html: string, compression: 1 | 2, encoding = 65001): Uint8Array {
  const data = new TextEncoder().encode(html);
  const records: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 4096) records.push(data.subarray(i, i + 4096));
  const r0 = new Uint8Array(16 + 232 + 8);
  const v = new DataView(r0.buffer);
  v.setUint16(0, compression);
  v.setUint32(4, data.length);
  v.setUint16(8, records.length);
  v.setUint16(10, 4096);
  r0.set(new TextEncoder().encode("MOBI"), 16);
  v.setUint32(20, 232);
  v.setUint32(28, encoding);
  const all = [r0, ...records];
  const header = new Uint8Array(78 + all.length * 8 + 2);
  header.set(new TextEncoder().encode("BOOKMOBI"), 60);
  new DataView(header.buffer).setUint16(76, all.length);
  let off = header.length;
  all.forEach((r, i) => {
    new DataView(header.buffer).setUint32(78 + i * 8, off);
    off += r.length;
  });
  return Uint8Array.from([...header, ...all.flatMap((r) => [...r])]);
}

test("MOBI text is extracted from uncompressed books and refuses what it cannot read", () => {
  const html = "<html><body><h1>Глава 1</h1><p>Тихая гавань &amp; фонарь</p><mbp:pagebreak/><p>Second</p></body></html>";
  expect(mobiText(makeMobi(html, 1))).toBe("Глава 1\nТихая гавань & фонарь\nSecond");
  expect(mobiText(makeMobi("x".repeat(9000), 1))?.length).toBe(9000); // more than one record
  const locked = makeMobi(html, 1);
  const r0 = new DataView(locked.buffer).getUint32(78); // where record 0 starts
  new DataView(locked.buffer).setUint16(r0 + 12, 2); // DRM
  expect(mobiText(locked)).toBeNull();
  const huff = makeMobi(html, 1);
  new DataView(huff.buffer).setUint16(new DataView(huff.buffer).getUint32(78), 17480); // HUFF/CDIC
  expect(mobiText(huff)).toBeNull();
  expect(mobiText(new TextEncoder().encode("not a mobi file at all, just text"))).toBeNull();
});
