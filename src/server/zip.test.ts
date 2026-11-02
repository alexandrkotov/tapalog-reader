import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { extractEntry, zipEntries } from "./zip";
import { removeDir } from "./testutil";

const dir = mkdtempSync(join(tmpdir(), "reader-zip-"));
afterAll(() => removeDir(dir));

const make = (name: string, files: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]>) => {
  const path = join(dir, name);
  writeFileSync(path, zipSync(files));
  return path;
};
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "no error";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

test("the entries of a zip are listed without reading the files, and a deflated and a stored one come out intact", async () => {
  const text = "A book. ".repeat(5000);
  const path = make("a.zip", { "Книга/book.fb2": [strToU8(text), { level: 6 }], "readme.txt": [strToU8("stored"), { level: 0 }], "empty/": new Uint8Array() });
  const entries = await zipEntries(path);
  expect(entries.map((e) => [e.name, e.directory, e.method])).toEqual([["Книга/book.fb2", false, 8], ["readme.txt", false, 0], ["empty/", true, 8]]);
  expect(entries[0]!.size).toBe(text.length);
  expect(entries[0]!.compressed).toBeLessThan(text.length / 10);
  const out = join(dir, "out.fb2");
  expect(await extractEntry(path, entries[0]!, out, 1 << 30)).toBe(text.length);
  expect(readFileSync(out, "utf-8")).toBe(text);
  await extractEntry(path, entries[1]!, out, 1 << 30);
  expect(readFileSync(out, "utf-8")).toBe("stored");
});

test("what is not a zip, or is damaged, or would unpack to too much, is refused with a reason", async () => {
  const bad = join(dir, "bad.zip");
  writeFileSync(bad, "this is not a zip file, only text ".repeat(20));
  expect(await code(zipEntries(bad))).toBe("not-zip");
  writeFileSync(bad, "");
  expect(await code(zipEntries(bad))).toBe("not-zip");

  const text = strToU8("x".repeat(100_000));
  const path = make("big.zip", { "a.txt": [text, { level: 6 }] });
  const [entry] = await zipEntries(path);
  expect(await code(extractEntry(path, entry!, join(dir, "o1"), 1000))).toBe("too-big");

  // a claim of a small size over data that inflates to more (a zip bomb) stops at the claim
  const forged = readFileSync(path);
  const at = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); // the central directory entry
  forged.writeUInt32LE(100, at + 24);
  const forgedPath = join(dir, "forged.zip");
  writeFileSync(forgedPath, forged);
  const [claim] = await zipEntries(forgedPath);
  expect(await code(extractEntry(forgedPath, claim!, join(dir, "o2"), 1 << 30))).toBe("damaged");

  // a flipped byte in the data: the checksum catches it
  const flipped = readFileSync(make("flip.zip", { "a.txt": [strToU8("some text to be stored as it is"), { level: 0 }] }));
  const flippedAt = flipped.indexOf("some text");
  flipped[flippedAt] = flipped[flippedAt]! ^ 1;
  const flippedPath = join(dir, "flipped.zip");
  writeFileSync(flippedPath, flipped);
  const [stored] = await zipEntries(flippedPath);
  expect(await code(extractEntry(flippedPath, stored!, join(dir, "o3"), 1 << 30))).toBe("damaged");

  // a password-protected entry
  const locked = readFileSync(make("lock.zip", { "a.txt": [strToU8("secret"), { level: 0 }] }));
  const lockedAt = locked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  locked.writeUInt16LE(locked.readUInt16LE(lockedAt + 8) | 1, lockedAt + 8);
  const lockedPath = join(dir, "locked.zip");
  writeFileSync(lockedPath, locked);
  const [secret] = await zipEntries(lockedPath);
  expect(secret!.encrypted).toBe(true);
  expect(await code(extractEntry(lockedPath, secret!, join(dir, "o4"), 1 << 30))).toBe("encrypted");
});
