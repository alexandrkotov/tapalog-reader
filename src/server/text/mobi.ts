import { htmlToText } from "./html";

const ENCODINGS: Record<number, string> = { 1252: "windows-1252", 65001: "utf-8" };

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** PalmDOC LZ77, as in foliate-js's mobi.js (MIT) and the Mobipocket documentation. */
export function decompressPalmDoc(array: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < array.length; i++) {
    const byte = array[i]!;
    if (byte === 0) out.push(0);
    else if (byte <= 8) for (const x of array.subarray(i + 1, (i += byte) + 1)) out.push(x);
    else if (byte <= 0x7f) out.push(byte);
    else if (byte <= 0xbf) {
      const pair = (byte << 8) | (array[i++ + 1] ?? 0);
      const distance = (pair & 0x3fff) >>> 3;
      const length = (pair & 7) + 3;
      for (let j = 0; j < length; j++) out.push(out[out.length - distance] ?? 0);
    } else out.push(32, byte ^ 0x80);
  }
  return Uint8Array.from(out);
}

const countBits = (x: number) => {
  let n = 0;
  for (; x > 0; x >>= 1) n += x & 1;
  return n;
};

/** The size of one trailing entry, a variable-length number stored at the end of a text record. */
function trailingEntrySize(array: Uint8Array): number {
  let value = 0;
  for (const byte of array.subarray(-4)) {
    if (byte & 0x80) value = 0;
    value = (value << 7) | (byte & 0x7f);
  }
  return value;
}

/**
 * The text of a MOBI/AZW3 book, or null when it cannot be read here: DRM, or the old
 * Huffman/CDIC compression (rare; the reader in the browser handles it, the indexer does not).
 */
export function mobiText(file: Uint8Array): string | null {
  if (file.length < 100 || String.fromCharCode(...file.subarray(60, 68)) !== "BOOKMOBI") return null;
  const numRecords = u16(file, 76);
  const offsets = Array.from({ length: numRecords }, (_, i) => u32(file, 78 + i * 8));
  const record = (i: number) => file.subarray(offsets[i] ?? file.length, offsets[i + 1] ?? file.length);

  const r0 = record(0);
  const compression = u16(r0, 0);
  const textRecords = u16(r0, 8);
  const encryption = u16(r0, 12);
  if (encryption !== 0 || (compression !== 1 && compression !== 2) || String.fromCharCode(...r0.subarray(16, 20)) !== "MOBI") return null;
  const headerLength = u32(r0, 20);
  const encoding = ENCODINGS[u32(r0, 28)] ?? "utf-8";
  const trailingFlags = headerLength >= 228 && r0.length >= 244 ? u32(r0, 240) : 0;
  const multibyte = trailingFlags & 1;
  const entries = countBits(trailingFlags >>> 1);

  const parts: Uint8Array[] = [];
  for (let i = 1; i <= textRecords && i < numRecords; i++) {
    let data = record(i);
    for (let e = 0; e < entries && data.length; e++) data = data.subarray(0, Math.max(0, data.length - trailingEntrySize(data)));
    if (multibyte && data.length) data = data.subarray(0, Math.max(0, data.length - ((data[data.length - 1]! & 3) + 1)));
    parts.push(compression === 2 ? decompressPalmDoc(data) : data);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return htmlToText(new TextDecoder(encoding).decode(all));
}
