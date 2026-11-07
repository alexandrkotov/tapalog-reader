import type { Database } from "bun:sqlite";
import { open } from "node:fs/promises";
import { readEntry, zipEntries } from "./zip";
import { decodeEntities, htmlToText } from "./text/html";

/**
 * What the library knows about a book besides its file: title, authors, year, series, description,
 * language and tags. It belongs to the book's content (like bookmarks do), not to its file name or path,
 * so a rename or a move keeps it, and it is the library's, not a reader's: the administrator edits it.
 *
 * Two sources are kept apart: `auto` is read out of the file (EPUB and FB2 carry it) and can be made
 * again at any time; `manual` is what the administrator typed, wins over `auto` field by field, and is
 * the part that goes into the backup. Deleting a manual value brings the extracted one back.
 */
export interface Fields {
  title: string;
  authors: string[];
  year: number | null;
  series: string;
  description: string;
  language: string;
  tags: string[];
}
export const FIELD_NAMES = ["title", "authors", "year", "series", "description", "language", "tags"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
/** The fields the administrator has set; a field that is absent is not set (the extracted value, if any, shows). */
export type Manual = { [K in FieldName]?: Fields[K] };
/** The fields read out of the file; tags are never extracted. */
export type Auto = Partial<Omit<Fields, "tags">>;

export const MAX_TITLE = 300;
export const MAX_AUTHOR = 150;
export const MAX_AUTHORS = 30;
export const MAX_SERIES = 200;
export const MAX_DESCRIPTION = 5000;
export const MAX_TAG = 40;
export const MAX_TAGS = 30;
/** Bump when the extraction learns to read more, so books read before are read again. */
export const AUTO_VERSION = 1;

export class MetaError extends Error {}

const clean = (value: unknown, max: number, what: string): string => {
  if (typeof value !== "string") throw new MetaError(what);
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim();
  if (text.length > max) throw new MetaError(what);
  return text;
};
const oneLine = (value: unknown, max: number, what: string): string => clean(typeof value === "string" ? value.replace(/\s+/g, " ") : value, max, what);

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS * 4) throw new MetaError("tags");
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    const tag = oneLine(raw, MAX_TAG, "tags");
    if (!tag || seen.has(tag.toLowerCase())) continue; // an empty or repeated tag is dropped, not an error
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) throw new MetaError("tags");
  return tags;
}

/** Checks one field's value; throws a MetaError (carrying the field's name) for what cannot be stored. */
function cleanField<K extends FieldName>(name: K, value: unknown): Fields[K] {
  switch (name) {
    case "title":
      return oneLine(value, MAX_TITLE, name) as Fields[K];
    case "series":
      return oneLine(value, MAX_SERIES, name) as Fields[K];
    case "description":
      return clean(typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n") : value, MAX_DESCRIPTION, name) as Fields[K];
    case "language":
      if (typeof value !== "string" || (value.trim() !== "" && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(value.trim()))) throw new MetaError(name);
      return value.trim().toLowerCase() as Fields[K];
    case "year":
      if (value === null) return null as Fields[K];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3000) throw new MetaError(name);
      return value as Fields[K];
    case "authors": {
      if (!Array.isArray(value) || value.length > MAX_AUTHORS * 4) throw new MetaError(name);
      const authors = value.map((a) => oneLine(a, MAX_AUTHOR, name)).filter(Boolean);
      if (authors.length > MAX_AUTHORS) throw new MetaError(name);
      return authors as Fields[K];
    }
    case "tags":
      return cleanTags(value) as Fields[K];
    default:
      throw new MetaError("unknown field");
  }
}

/** The fields of a stored or uploaded `manual` object, checked; an unknown field is an error. */
export function cleanManual(raw: unknown): Manual {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MetaError("manual");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(FIELD_NAMES as readonly string[]).includes(key)) throw new MetaError("unknown field");
    out[key] = cleanField(key as FieldName, value);
  }
  return out as Manual;
}

/** What an edit does to `manual`: `set` puts values in (a blank is a value too: it hides an extracted one), `reset` takes values out so the extracted ones show again. */
export function applyEdit(manual: Manual, set: unknown, reset: unknown): Manual {
  if (set !== undefined && (!set || typeof set !== "object" || Array.isArray(set))) throw new MetaError("set");
  if (reset !== undefined && (!Array.isArray(reset) || reset.some((r) => !(FIELD_NAMES as readonly string[]).includes(r as string)))) throw new MetaError("reset");
  const next: Record<string, unknown> = { ...manual };
  for (const [key, value] of Object.entries((set as Record<string, unknown>) ?? {})) {
    if (!(FIELD_NAMES as readonly string[]).includes(key)) throw new MetaError("unknown field");
    next[key] = cleanField(key as FieldName, value);
  }
  for (const key of (reset as string[]) ?? []) delete next[key];
  return next as Manual;
}

const EMPTY: Fields = { title: "", authors: [], year: null, series: "", description: "", language: "", tags: [] };

/** The values the library shows: a manual one where there is one, else the extracted one, else nothing. */
export function effective(manual: Manual, auto: Auto): Fields {
  const out: Fields = { ...EMPTY, authors: [], tags: [] };
  for (const name of FIELD_NAMES) {
    let value: unknown;
    if (Object.hasOwn(manual, name)) value = manual[name];
    else if (name !== "tags" && auto[name as keyof Auto] !== undefined) value = auto[name as keyof Auto];
    else continue;
    (out as unknown as Record<string, unknown>)[name] = value;
  }
  return out;
}

/** The part of the metadata every book in a list carries: the title is never blank (the file name stands in). */
export interface Shelf {
  title: string;
  authors: string[];
  year: number | null;
  series: string;
  tags: string[];
}

export interface MetaRow {
  manual: Manual;
  auto: Auto;
  autoVersion: number;
}

export function shelfFields(row: MetaRow | undefined, fileName: string): Shelf {
  const fields = effective(row?.manual ?? {}, row?.auto ?? {});
  return { title: fields.title || fileName, authors: fields.authors, year: fields.year, series: fields.series, tags: fields.tags };
}

/** The text a search looks in besides the file's path, lower-cased. */
export function searchText(row: MetaRow | undefined): string {
  if (!row) return "";
  const f = effective(row.manual, row.auto);
  return [f.title, ...f.authors, f.series, ...f.tags].join("\n").toLowerCase();
}

const parse = <T>(json: string, fallback: T): T => {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
};

export class BookMeta {
  constructor(private readonly db: Database) {}

  private toRow(r: { manual: string; auto: string; auto_v: number }): MetaRow {
    return { manual: parse<Manual>(r.manual, {}), auto: parse<Auto>(r.auto, {}), autoVersion: r.auto_v };
  }

  row(id: string): MetaRow | undefined {
    const r = this.db.query("SELECT manual, auto, auto_v FROM book_meta WHERE book_id = ?").get(id) as { manual: string; auto: string; auto_v: number } | null;
    return r ? this.toRow(r) : undefined;
  }

  all(): Map<string, MetaRow> {
    const rows = this.db.query("SELECT book_id, manual, auto, auto_v FROM book_meta").all() as { book_id: string; manual: string; auto: string; auto_v: number }[];
    return new Map(rows.map((r) => [r.book_id, this.toRow(r)]));
  }

  /** Whether the file has not been read for its metadata by this version of the extraction. */
  needsAuto(id: string): boolean {
    const r = this.db.query("SELECT auto_v FROM book_meta WHERE book_id = ?").get(id) as { auto_v: number } | null;
    return !r || r.auto_v < AUTO_VERSION;
  }

  setAuto(id: string, auto: Auto): void {
    this.db.run(
      "INSERT INTO book_meta (book_id, auto, auto_v, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(book_id) DO UPDATE SET auto = excluded.auto, auto_v = excluded.auto_v",
      [id, JSON.stringify(auto), AUTO_VERSION, Date.now()],
    );
  }

  /** Applies an edit (see `applyEdit`) and returns the manual values now in force. Throws a MetaError for a value that cannot be stored. */
  edit(id: string, set: unknown, reset: unknown): Manual {
    const manual = applyEdit(this.row(id)?.manual ?? {}, set, reset);
    this.setManual(id, manual);
    return manual;
  }

  setManual(id: string, manual: Manual): void {
    this.db.run(
      "INSERT INTO book_meta (book_id, manual, updated_at) VALUES (?, ?, ?) ON CONFLICT(book_id) DO UPDATE SET manual = excluded.manual, updated_at = excluded.updated_at",
      [id, JSON.stringify(manual), Date.now()],
    );
  }

  /** Every manual value, for the backup (the extracted ones come back from the files). */
  manualAll(): { bookId: string; manual: Manual }[] {
    return (this.db.query("SELECT book_id, manual FROM book_meta WHERE manual != '{}' ORDER BY book_id").all() as { book_id: string; manual: string }[]).map((r) => ({ bookId: r.book_id, manual: parse<Manual>(r.manual, {}) }));
  }

  /** Puts the backup's manual values in place of the present ones (the extracted ones stay). */
  replaceManual(entries: { bookId: string; manual: Manual }[]): void {
    this.db.transaction(() => {
      this.db.run("UPDATE book_meta SET manual = '{}'");
      for (const e of entries) this.setManual(e.bookId, e.manual);
    })();
  }

  /** Every tag in use with the number of distinct books carrying it, most used first. */
  tags(): { tag: string; books: number }[] {
    const counts = new Map<string, { tag: string; books: number }>();
    for (const row of this.all().values()) {
      for (const tag of row.manual.tags ?? []) {
        const key = tag.toLowerCase();
        const entry = counts.get(key) ?? { tag, books: 0 };
        entry.books++;
        counts.set(key, entry);
      }
    }
    return [...counts.values()].sort((a, b) => b.books - a.books || a.tag.localeCompare(b.tag));
  }
}

// ---------------------------------------------------------------- reading the files

const MAX_OPF = 1024 * 1024;
const FB2_HEAD = 256 * 1024;

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find((x) => x !== undefined);
const unwrap = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
/** One line of text out of a piece of XML: tags dropped, entities decoded. */
const line = (s: string) => decodeEntities(unwrap(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
/** A longer text out of a piece of XML that may hold escaped HTML: paragraphs become lines. */
const text = (s: string) => htmlToText(decodeEntities(unwrap(s))).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const yearIn = (s: string): number | undefined => {
  const year = Number(/(?<!\d)(\d{4})(?!\d)/.exec(s)?.[1]);
  return year >= 1000 && year <= 2999 ? year : undefined;
};

/** Puts what was found through the same limits as typing it, dropping what does not fit instead of failing. */
function tidy(found: { title?: string; authors?: string[]; year?: number; series?: string; description?: string; language?: string }): Auto {
  const out: Auto = {};
  const take = <K extends keyof Auto>(name: K, value: unknown) => {
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
    try {
      const done = cleanField(name as FieldName, value);
      if (done !== "" && !(Array.isArray(done) && done.length === 0)) (out as Record<string, unknown>)[name] = done;
    } catch {
      /* too long or malformed: the file's own value is not worth an error */
    }
  };
  take("title", found.title?.slice(0, MAX_TITLE));
  take("authors", found.authors?.slice(0, MAX_AUTHORS).map((a) => a.slice(0, MAX_AUTHOR)));
  take("year", found.year);
  take("series", found.series?.slice(0, MAX_SERIES));
  take("description", found.description?.slice(0, MAX_DESCRIPTION));
  take("language", found.language);
  return out;
}

/** The metadata block of an EPUB's package file (OPF). */
export function parseOpf(xml: string): Auto {
  const block = /<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/i.exec(xml)?.[0] ?? xml;
  const values = (name: string): { tag: string; body: string }[] =>
    [...block.matchAll(new RegExp(`<(?:dc:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:dc:)?${name}>)`, "gi"))].map((m) => ({ tag: m[1] ?? "", body: m[2] ?? "" }));
  const authors = values("creator")
    .filter((c) => {
      const role = attr(c.tag, "(?:opf:)?role");
      return !role || role.toLowerCase() === "aut";
    })
    .map((c) => line(c.body))
    .filter(Boolean);
  const calibre = [...block.matchAll(/<meta\b[^>]*>/gi)].find((m) => attr(m[0], "name")?.toLowerCase() === "calibre:series");
  const collection = /<meta\b[^>]*\bproperty\s*=\s*["']belongs-to-collection["'][^>]*>([\s\S]*?)<\/meta>/i.exec(block);
  return tidy({
    title: values("title")[0] ? line(values("title")[0]!.body) : undefined,
    authors,
    year: values("date")[0] ? yearIn(line(values("date")[0]!.body)) : undefined,
    series: calibre ? (attr(calibre[0], "content") ? decodeEntities(attr(calibre[0], "content")!).trim() : undefined) : collection ? line(collection[1]!) : undefined,
    description: values("description")[0] ? text(values("description")[0]!.body) : undefined,
    language: values("language")[0] ? line(values("language")[0]!.body) : undefined,
  });
}

/** The `title-info` of an FB2 file. */
export function parseFb2(xml: string): Auto {
  const info = /<title-info\b[\s\S]*?<\/title-info>/i.exec(xml)?.[0];
  if (!info) return {};
  const first = (name: string, within = info) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(within)?.[1];
  const authors = [...info.matchAll(/<author\b[\s\S]*?<\/author>/gi)]
    .map((a) => {
      const parts = ["first-name", "middle-name", "last-name"].map((n) => line(first(n, a[0]) ?? "")).filter(Boolean);
      return parts.length ? parts.join(" ") : line(first("nickname", a[0]) ?? "");
    })
    .filter(Boolean);
  const date = /<date\b([^>]*)>([\s\S]*?)<\/date>/i.exec(info);
  const sequence = /<sequence\b[^>]*>/i.exec(info)?.[0];
  const annotation = first("annotation");
  return tidy({
    title: first("book-title") ? line(first("book-title")!) : undefined,
    authors,
    year: date ? (yearIn(attr(date[1]!, "value") ?? "") ?? yearIn(line(date[2]!))) : undefined,
    series: sequence && attr(sequence, "name") ? decodeEntities(attr(sequence, "name")!).trim() : undefined,
    description: annotation ? text(annotation) : undefined,
    language: first("lang") ? line(first("lang")!) : undefined,
  });
}

async function epubMeta(path: string): Promise<Auto> {
  const entries = await zipEntries(path);
  const find = (name: string) => entries.find((e) => !e.directory && e.name === name);
  const container = find("META-INF/container.xml");
  if (!container) return {};
  const rootfile = /<rootfile\b[^>]*>/i.exec(new TextDecoder().decode(await readEntry(path, container, MAX_OPF)))?.[0] ?? "";
  const opfPath = attr(rootfile, "full-path");
  const opf = opfPath ? find(opfPath) : undefined;
  return opf ? parseOpf(new TextDecoder().decode(await readEntry(path, opf, MAX_OPF))) : {};
}

async function fb2Meta(path: string): Promise<Auto> {
  const file = await open(path, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(FB2_HEAD);
    const { bytesRead } = await file.read(bytes, 0, FB2_HEAD, 0);
    bytes = bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  // As for searching: FB2 files from the Russian-speaking world are very often windows-1251, and the XML declaration says so.
  const label = /^<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 200)))?.[1] ?? "utf-8";
  let xml: string;
  try {
    xml = new TextDecoder(label).decode(bytes);
  } catch {
    xml = new TextDecoder("utf-8").decode(bytes);
  }
  return parseFb2(xml);
}

/** The formats whose files carry metadata this program reads. */
export const META_FORMATS = new Set(["epub", "fb2"]);

/** Reads the metadata out of a book file; an empty object when the format has none or the file is not what it says. */
export async function extractMeta(path: string, ext: string): Promise<Auto> {
  if (ext === "epub") return epubMeta(path);
  if (ext === "fb2") return fb2Meta(path);
  return {};
}
