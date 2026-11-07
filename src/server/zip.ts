import { crc32, createInflateRaw, inflateRawSync } from "node:zlib";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ZipErrorCode =
  | "not-zip" // not a zip file at all, or one this reader does not handle (zip64, split archives)
  | "encrypted" // needs a password
  | "unsupported" // packed with a method other than "stored" or "deflate"
  | "damaged" // the pieces do not fit together, or the data does not match its checksum
  | "too-big"; // would unpack to more than allowed

export class ZipError extends Error {
  constructor(readonly code: ZipErrorCode) {
    super(code);
  }
}

export interface ZipEntry {
  /** As stored: UTF-8 when the archive says so, else read byte for byte (enough to see the extension). */
  name: string;
  directory: boolean;
  method: number;
  encrypted: boolean;
  compressed: number;
  size: number;
  crc: number;
  /** Where this entry's local header starts. */
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_DIRECTORY = 16 * 1024 * 1024;

/**
 * The entries of a zip file, read from its central directory without reading the files themselves,
 * so a multi-gigabyte archive costs a few kilobytes. Zip64 archives (over 4 GB or 65535 entries) are
 * not handled: nothing this program downloads comes near.
 */
export async function zipEntries(path: string): Promise<ZipEntry[]> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    let at = tailLength - 22;
    while (at >= 0 && tail.readUInt32LE(at) !== EOCD) at--;
    if (at < 0) throw new ZipError("not-zip");
    const count = tail.readUInt16LE(at + 10);
    const length = tail.readUInt32LE(at + 12);
    const start = tail.readUInt32LE(at + 16);
    if (tail.readUInt16LE(at + 4) !== 0 || count === 0xffff || length === 0xffffffff || start === 0xffffffff) throw new ZipError("not-zip");
    if (length > MAX_DIRECTORY || start + length > size) throw new ZipError("damaged");

    const directory = Buffer.alloc(length);
    await file.read(directory, 0, length, start);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > length || directory.readUInt32LE(p) !== CENTRAL) throw new ZipError("damaged");
      const flags = directory.readUInt16LE(p + 8);
      const nameLength = directory.readUInt16LE(p + 28);
      const extra = directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
      if (p + 46 + nameLength > length) throw new ZipError("damaged");
      const raw = directory.subarray(p + 46, p + 46 + nameLength);
      const name = flags & 0x800 ? raw.toString("utf8") : raw.toString("latin1");
      const entry: ZipEntry = {
        name,
        directory: name.endsWith("/"),
        method: directory.readUInt16LE(p + 10),
        encrypted: (flags & 1) !== 0,
        crc: directory.readUInt32LE(p + 16),
        compressed: directory.readUInt32LE(p + 20),
        size: directory.readUInt32LE(p + 24),
        offset: directory.readUInt32LE(p + 42),
      };
      if (entry.compressed === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) throw new ZipError("not-zip"); // zip64
      entries.push(entry);
      p += 46 + nameLength + extra;
    }
    return entries;
  } finally {
    await file.close();
  }
}

/**
 * Unpacks one entry into `target`, checking as it goes that it does not grow past what the archive
 * said (or `maxBytes`: a "zip bomb" is stopped when it passes its own claim) and that its checksum matches.
 */
export async function extractEntry(path: string, entry: ZipEntry, target: string, maxBytes: number): Promise<number> {
  if (entry.encrypted) throw new ZipError("encrypted");
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError("unsupported");
  if (entry.size > maxBytes) throw new ZipError("too-big");
  const file = await open(path, "r");
  let dataStart: number;
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(30);
    await file.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== LOCAL) throw new ZipError("damaged");
    dataStart = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (dataStart + entry.compressed > size) throw new ZipError("damaged");
  } finally {
    await file.close();
  }

  let written = 0;
  let sum = 0;
  const watch = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      written += chunk.length;
      if (written > entry.size) return done(new ZipError(entry.size > maxBytes ? "too-big" : "damaged"));
      sum = crc32(chunk, sum);
      done(null, chunk);
    },
  });
  const packed = Readable.fromWeb(Bun.file(path).slice(dataStart, dataStart + entry.compressed).stream() as unknown as import("node:stream/web").ReadableStream);
  try {
    await pipeline(packed, ...(entry.method === 8 ? [createInflateRaw()] : []), watch, createWriteStream(target));
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError("damaged"); // a deflate stream that does not decode
  }
  if (written !== entry.size || sum >>> 0 !== entry.crc) throw new ZipError("damaged");
  return written;
}

/** One entry of a zip file unpacked into memory, with the same checks as `extractEntry` (a size cap, the checksum). */
export async function readEntry(path: string, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError("encrypted");
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError("unsupported");
  if (entry.size > maxBytes) throw new ZipError("too-big");
  const file = await open(path, "r");
  let packed: Buffer;
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(30);
    await file.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== LOCAL) throw new ZipError("damaged");
    const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + entry.compressed > size) throw new ZipError("damaged");
    packed = Buffer.alloc(entry.compressed);
    await file.read(packed, 0, entry.compressed, start);
  } finally {
    await file.close();
  }
  let data: Buffer;
  try {
    data = entry.method === 8 ? inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) }) : packed;
  } catch {
    throw new ZipError("damaged"); // a deflate stream that does not decode, or grows past what the archive claimed
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError("damaged");
  return new Uint8Array(data.buffer, data.byteOffset, data.length);
}
