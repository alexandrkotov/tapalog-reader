/** Book formats the library lists. The reader for each one is chosen on the web side. */
export const FORMATS = ["pdf", "epub", "fb2", "djvu", "cbz", "mobi", "txt", "ecatm"] as const;
export type Format = (typeof FORMATS)[number];

const BY_EXT = new Map<string, Format>([
  ...FORMATS.map((f): [string, Format] => [f, f]),
  ["azw3", "mobi"],
  ["djv", "djvu"],
]);

export function formatOf(fileName: string): Format | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXT.get(fileName.slice(dot + 1).toLowerCase()) ?? null;
}

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
