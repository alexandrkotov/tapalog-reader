/**
 * Old text files are rarely labelled. UTF-8 and UTF-16 with a BOM are certain. Text that is
 * not valid UTF-8 is taken to be Windows-1251 when its high bytes look like Russian words
 * (mostly letters, mostly next to each other), otherwise Windows-1252, whose accented
 * letters sit alone between ASCII ones.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const sample = bytes.subarray(0, 65536);
    let high = 0;
    let letters = 0;
    let adjacent = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i]! < 0x80) continue;
      high++;
      if (sample[i]! >= 0xc0) letters++; // А–я in Windows-1251
      if (sample[i + 1]! >= 0x80) adjacent++;
    }
    const cyrillic = high > 0 && letters / high > 0.6 && adjacent / high > 0.5;
    return new TextDecoder(cyrillic ? "windows-1251" : "windows-1252").decode(bytes);
  }
}
