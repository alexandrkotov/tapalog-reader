/** Book formats the library lists. The reader for each one is chosen on the web side. */
export const FORMATS = ["pdf", "epub", "fb2", "djvu", "cbz", "mobi", "txt", "ecatm"] as const;
export type Format = (typeof FORMATS)[number];

const BY_EXT = new Map<string, Format>([
  ...FORMATS.map((f): [string, Format] => [f, f]),
  ["azw3", "mobi"],
  ["djv", "djvu"],
]);

/** Formats that plugins add (see plugins.ts): extension -> the format's name, which is the plugin's first extension. */
const EXTRA = new Map<string, string>();
const EXTRA_MIME = new Map<string, string>();

/** Built-in formats win: a plugin cannot take over an extension the program already opens, only add new ones or give the readerless .djvu a reader. */
export function registerFormats(formats: { exts: string[]; mime: string }[]): void {
  EXTRA.clear();
  EXTRA_MIME.clear();
  for (const { exts, mime } of formats) {
    const name = exts.find((ext) => !BY_EXT.has(ext)); // the format is named by the plugin's first extension that is really new
    if (!name) continue;
    for (const ext of exts) if (!BY_EXT.has(ext) && !EXTRA.has(ext)) EXTRA.set(ext, name);
    EXTRA_MIME.set(name, mime);
  }
}

/** The library's name for the file's format (the first extension of its plugin for a plugin's), or null if it is not a book. */
export function formatOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return BY_EXT.get(ext) ?? EXTRA.get(ext) ?? null;
}

export const mimeOf = (format: string): string => MIME[format as Format] ?? EXTRA_MIME.get(format) ?? "application/octet-stream";

export const MIME: Record<Format, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  fb2: "application/x-fictionbook+xml",
  djvu: "image/vnd.djvu",
  cbz: "application/vnd.comicbook+zip",
  mobi: "application/x-mobipocket-ebook",
  txt: "text/plain; charset=utf-8",
  ecatm: "application/vnd.sqlite3",
};
