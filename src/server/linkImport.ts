import { renameSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { formatOf, type Format } from "./formats";
import { EditError, type LibraryEditor } from "./editor";
import type { Library } from "./library";
import { contentId } from "./scanner";
import { safeGet, UnsafeAddress } from "./safeGet";
import { extractEntry, zipEntries, ZipError, type ZipEntry } from "./zip";

export type ImportErrorCode =
  | "bad-link" // not an http(s) link at all
  | "folder" // a Drive folder, not a file
  | "not-a-file" // a Google Doc, Sheet or Slides: there is no book file in it
  | "web-page" // the link opens a web page, not a file
  | "not-found"
  | "closed" // not open to anyone with the link, or a daily download limit is used up
  | "local-address" // a link into this computer or its local network: never followed
  | "duplicate" // the same book is already in the library (the job says where)
  | "unsupported" // a file that is not one of the library's formats
  | "wrong-content" // the bytes are not what the name says (an error page, a different file type)
  | "archive-empty" // a zip with no book in it
  | "archive-many" // a zip with several books: which one is wanted is not for the program to guess
  | "archive-encrypted" // a zip that needs a password
  | "archive-broken" // a zip that is damaged or packed in a way that is not handled
  | "too-big"
  | "unreachable"
  | "busy"
  | "failed";

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

/** Where Google Drive links are fetched from. A Drive link supplies a file id and nothing else: every address is built here. */
export interface DriveEndpoints {
  download(id: string): string;
  thumbnail(id: string): string;
  /** Whether a redirect may be followed to this address. */
  trusted(url: URL): boolean;
  /** The one origin outside the internet that may be fetched (the stand-in server of the browser tests, never set otherwise). */
  local?: string;
}

const googleHost = (host: string) => host === "google.com" || host.endsWith(".google.com") || host.endsWith(".googleusercontent.com");

const GOOGLE: DriveEndpoints = {
  download: (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
  thumbnail: (id) => `https://drive.google.com/thumbnail?id=${id}&sz=w300`,
  trusted: (url) => url.protocol === "https:" && googleHost(url.hostname),
};

const FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;
export const isFileId = (id: string) => FILE_ID.test(id);

const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com", "drive.usercontent.google.com"]);
const GOOGLE_DOCS = /^\/(?:u\/\d+\/)?(?:document|spreadsheets|presentation|forms|drawings)\//;

export type Link = { drive: string; url?: undefined } | { url: URL; drive?: undefined };

/**
 * What the administrator pasted: a Google Drive link (in any of its forms, which gives a file id and
 * nothing else) or the address of a file anywhere else. A link wrapped in a Facebook redirect is
 * unwrapped first; the wrapper itself is never requested.
 */
export function parseLink(text: string): Link {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new ImportError("bad-link");
  }
  for (let wrapped = 0; wrapped < 3 && (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com")) && url.pathname === "/l.php"; wrapped++) {
    try {
      url = new URL(url.searchParams.get("u") ?? "");
    } catch {
      throw new ImportError("bad-link");
    }
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) throw new ImportError("bad-link");
  if (!DRIVE_HOSTS.has(url.hostname)) return { url };
  if (GOOGLE_DOCS.test(url.pathname)) throw new ImportError("not-a-file");
  if (/\/folders\//.test(url.pathname)) throw new ImportError("folder");
  const id = /\/file\/d\/([^/?#]+)/.exec(url.pathname)?.[1] ?? (/^\/(?:u\/\d+\/)?(?:open|uc|download)$/.test(url.pathname) ? url.searchParams.get("id") : null);
  if (!id || !isFileId(id)) throw new ImportError("bad-link");
  return { drive: id };
}

export interface Inspected {
  /** The Drive file id, when the link was a Drive one (its picture can be shown); null for any other address. */
  id: string | null;
  /** The file name without its extension, made safe to use as a name in the library. */
  name: string;
  ext: string;
  /** In bytes; 0 when the server does not say. */
  size: number;
  /** A zip file: the book is taken out of it once it is here, and `ext` is only a guess ("zip" when there is none) from a name like book.fb2.zip. */
  archive: boolean;
}

/** What a server's content type says when the name has no extension the library knows. */
const TYPE_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "image/vnd.djvu": "djvu",
  "image/x-djvu": "djvu",
  "application/x-fictionbook+xml": "fb2",
  "application/x-mobipocket-ebook": "mobi",
  "application/vnd.comicbook+zip": "cbz",
  "application/x-cbz": "cbz",
  "text/plain": "txt",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-zip": "zip",
};

const isZipName = (file: string) => /\.zip$/i.test(file);

/** The file's name: the one the server gives, else the last part of the address; the content type fills in a missing extension. */
function fileNameFor(disposition: string | null, finalUrl: URL | null, type: string | null): string | null {
  let file = fileNameFrom(disposition);
  if (!file && finalUrl) {
    const last = finalUrl.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      file = decodeURIComponent(last);
    } catch {
      file = last;
    }
  }
  if (file && (formatOf(file) || isZipName(file))) return file;
  const ext = TYPE_EXT[(type ?? "").split(";")[0]!.trim().toLowerCase()];
  return ext ? `${file || "Book"}.${ext}` : file || null;
}

const decodeLatin1 = (s: string): string => {
  if (/[^\u0000-ÿ]/.test(s)) return s;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
};

/** Bun hands header bytes over as Latin-1, so a UTF-8 name arrives garbled and is decoded again here. */
export function fileNameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(header)?.[1];
  return plain ? decodeLatin1(plain.trim().replace(/\\(.)/g, "$1")) : null;
}

/** Characters a file name may not have on some system become spaces; the administrator can still change the result. */
export function suggestName(base: string): string {
  const name = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 200)
    .trim();
  return name || "Book";
}

const sniff: Partial<Record<Format, (head: Uint8Array) => boolean>> = {
  pdf: (h) => text(h, 0, "%PDF"),
  epub: (h) => text(h, 0, "PK"),
  cbz: (h) => text(h, 0, "PK"),
  djvu: (h) => text(h, 0, "AT&TFORM"),
  ecatm: (h) => text(h, 0, "SQLite format 3"),
};
const text = (bytes: Uint8Array, at: number, expected: string) => expected.split("").every((c, i) => bytes[at + i] === c.charCodeAt(0));
const looksLikeHtml = (head: Uint8Array) => /^\s*<(!doctype html|html)/i.test(new TextDecoder().decode(head));

type Slot = ReturnType<LibraryEditor["reserve"]>;

export interface ImportJob {
  id: string;
  state: "running" | "done" | "failed";
  received: number;
  total: number;
  /** Where the book ended up and its id, once done. */
  path: string | null;
  bookId: string | null;
  error: string | null;
  /** With the error "duplicate": where the same book already is. */
  duplicateOf: string | null;
  /** The download is over and the book is being taken out of a zip. */
  unpacking: boolean;
}

interface Running extends ImportJob {
  /** Save the book even when the library already has it. */
  keep: boolean;
  abort: AbortController;
  finished: number;
}

const MAX_RUNNING = 3;
const KEEP_MS = 10 * 60_000;
const THUMB_BYTES = 1_500_000;

/**
 * Fetching a book from a link into the library, on behalf of the administrator: a Google Drive share
 * link or the address of a file on any site. Links that lead into this computer or its local network
 * are refused, so the program cannot be used to reach what the internet cannot.
 */
export class LinkImports {
  private readonly jobs = new Map<string, Running>();

  constructor(
    private readonly library: Library,
    private readonly editor: LibraryEditor,
    private readonly endpoints: DriveEndpoints = GOOGLE,
    private readonly maxBytes = 2 * 1024 ** 3,
  ) {}

  /** Sends a request and follows its redirects itself, asking `send` about every hop, so none can lead anywhere unchecked. */
  private async follow(first: string, send: (target: URL) => Promise<Response>): Promise<{ res: Response; url: URL }> {
    let url = first;
    for (let hop = 0; hop < 5; hop++) {
      const target = new URL(url);
      const res = await send(target);
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) return { res, url: target };
      await res.body?.cancel();
      try {
        url = new URL(next, target).href;
      } catch {
        throw new ImportError("failed");
      }
    }
    throw new ImportError("failed");
  }

  /** Google Drive: only the trusted hosts. */
  private get(url: string, init: RequestInit): Promise<Response> {
    return this.follow(url, async (target) => {
      if (!this.endpoints.trusted(target)) throw new ImportError("unreachable");
      try {
        return await fetch(target, { ...init, redirect: "manual" });
      } catch {
        throw new ImportError("unreachable");
      }
    }).then((r) => r.res);
  }

  /** Any other site: public internet addresses only (see safeGet). */
  private getAnywhere(url: URL, init: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ res: Response; url: URL }> {
    return this.follow(url.href, async (target) => {
      if (!["http:", "https:"].includes(target.protocol)) throw new ImportError("bad-link");
      try {
        return await safeGet(target, init, this.endpoints.local && target.origin === this.endpoints.local ? () => true : undefined);
      } catch (err) {
        if (err instanceof UnsafeAddress) throw new ImportError("local-address");
        if (init.signal?.aborted) throw err;
        throw new ImportError("unreachable");
      }
    });
  }

  /** The answer to a download request, or why there is none. */
  private async download(target: Link, init: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ res: Response; url: URL | null }> {
    const { res, url } = target.url ? await this.getAnywhere(target.url, init) : { res: await this.get(this.endpoints.download(target.drive), init), url: null };
    const html = (res.headers.get("content-type") ?? "").startsWith("text/html");
    if (res.ok && !html) return { res, url };
    await res.body?.cancel();
    if (res.status === 404 || res.status === 410) throw new ImportError("not-found");
    if (!target.url) {
      // a web page where the file should be is Drive's sign-in or daily-limit page
      throw new ImportError(res.ok || [401, 403, 429].includes(res.status) ? "closed" : "failed");
    }
    if (res.ok) throw new ImportError("web-page");
    throw new ImportError([401, 403, 429].includes(res.status) ? "closed" : "failed");
  }

  /** Name and size of the file, learned by asking for its first byte. */
  async inspect(link: string): Promise<Inspected> {
    const target = parseLink(link);
    const { res, url } = await this.download(target, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(30_000) });
    const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
    const length = res.status === 200 ? res.headers.get("content-length") : null; // on a 206 the length is that of the one byte
    const size = total !== undefined ? Number(total) : length !== null ? Number(length) : 0;
    await res.body?.cancel();
    const file = fileNameFor(res.headers.get("content-disposition"), url, res.headers.get("content-type"));
    if (!file || !Number.isFinite(size)) throw new ImportError("failed");
    const archive = isZipName(file);
    if (!archive && !formatOf(file)) throw new ImportError("unsupported");
    // book.fb2.zip: the name is "book" and the book inside is likely an fb2
    const unzipped = archive ? file.slice(0, -4) : file;
    const dot = unzipped.lastIndexOf(".");
    const guess = dot > 0 && formatOf(unzipped) ? unzipped.slice(dot + 1).toLowerCase() : archive ? "zip" : null;
    const base = guess && guess !== "zip" ? unzipped.slice(0, dot) : unzipped.slice(0, archive ? undefined : dot);
    return { id: target.drive ?? null, name: suggestName(base), ext: guess ?? file.slice(file.lastIndexOf(".") + 1).toLowerCase(), size, archive };
  }

  /** The picture Drive shows for the file, passed on so the page does not have to talk to Google. */
  async thumbnail(id: string): Promise<{ type: string; bytes: Uint8Array<ArrayBuffer> } | null> {
    if (!isFileId(id)) return null;
    try {
      const res = await this.get(this.endpoints.thumbnail(id), { signal: AbortSignal.timeout(30_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type.split(";")[0]!.trim())) {
        await res.body?.cancel();
        return null;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return bytes.length > 0 && bytes.length <= THUMB_BYTES ? { type: type.split(";")[0]!.trim(), bytes } : null;
    } catch {
      return null;
    }
  }

  /** Checks the target and begins the download in the background; the job says how it goes. */
  async start(link: string, folder: string, name: unknown, keepDuplicate = false): Promise<ImportJob> {
    this.sweep();
    if ([...this.jobs.values()].filter((j) => j.state === "running").length >= MAX_RUNNING) throw new ImportError("busy");
    const info = await this.inspect(link);
    if (info.size > this.maxBytes) throw new ImportError("too-big");
    const target = parseLink(link);
    const slot = this.editor.reserve(folder, name, info.ext);
    const job: Running = { id: crypto.randomUUID(), state: "running", received: 0, total: info.size, path: null, bookId: null, error: null, duplicateOf: null, unpacking: false, keep: keepDuplicate, abort: new AbortController(), finished: 0 };
    this.jobs.set(job.id, job);
    void this.run(job, target, info, slot, folder, name);
    return this.view(job);
  }

  private async run(job: Running, target: Link, info: Inspected, first: Slot, folder: string, name: unknown): Promise<void> {
    let slot = first;
    let ext = info.ext;
    const spare: string[] = [first.temp]; // removed if this fails: the download and what is made from it
    try {
      const { res } = await this.download(target, { signal: job.abort.signal });
      const file = await open(slot.temp, "w");
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          job.received += chunk.length;
          if (job.received > this.maxBytes) throw new ImportError("too-big");
          await file.write(chunk);
        }
      } finally {
        await file.close();
      }
      if (info.size && job.received !== info.size) throw new ImportError("failed"); // the connection ended early
      if (info.archive) {
        const zipHead = new Uint8Array(await Bun.file(first.temp).slice(0, 4).arrayBuffer());
        if (!text(zipHead, 0, "PK\u0003\u0004") && !text(zipHead, 0, "PK\u0005\u0006")) throw new ImportError("wrong-content"); // an error page or text with the name of a zip
        job.unpacking = true;
        const unpacked = await this.unpack(first.temp, folder, name, spare);
        slot = unpacked.slot;
        ext = unpacked.ext;
        job.unpacking = false;
      }
      const size = Bun.file(slot.temp).size;
      const head = new Uint8Array(await Bun.file(slot.temp).slice(0, 64).arrayBuffer());
      if (looksLikeHtml(head) || !(sniff[formatOf(`x.${ext}`) as Format]?.(head) ?? head.length > 0)) throw new ImportError("wrong-content");
      if (!job.keep) {
        const same = this.library.byId(await contentId(slot.temp, size));
        if (same) {
          job.duplicateOf = same.path;
          throw new ImportError("duplicate");
        }
      }
      job.path = slot.commit();
      if (slot !== first) await rm(first.temp, { force: true }); // the zip itself is not kept
      await this.library.rescan();
      for (let i = 0; i < 50 && !this.library.bookAt(job.path); i++) await Bun.sleep(100); // a scan already running will pick it up
      job.bookId = this.library.bookAt(job.path)?.id ?? null;
      job.state = "done";
    } catch (err) {
      for (const path of spare) await rm(path, { force: true });
      job.unpacking = false;
      job.state = "failed";
      job.error = job.abort.signal.aborted ? "cancelled" : err instanceof ImportError || err instanceof EditError ? err.code : "failed";
    } finally {
      job.finished = Date.now();
    }
  }

  /**
   * Takes the book out of a downloaded zip: the one file in it that is a book (a readme.txt beside a book
   * does not count), unpacked next to the zip under the name chosen. A zip that really is a comic (only
   * pictures) or an EPUB is kept as it is. Nothing is guessed: no book, or several, is an error.
   */
  private async unpack(zip: string, folder: string, name: unknown, spare: string[]): Promise<{ slot: Slot; ext: string }> {
    const fail = (err: unknown): never => {
      if (!(err instanceof ZipError)) throw err;
      throw new ImportError(err.code === "encrypted" ? "archive-encrypted" : err.code === "too-big" ? "too-big" : "archive-broken");
    };
    const entries = await zipEntries(zip).catch(fail);
    const files = entries.filter((e) => !e.directory && !e.name.split("/").some((part) => part === "__MACOSX" || part.startsWith(".")));
    const nameOf = (e: ZipEntry) => e.name.slice(e.name.lastIndexOf("/") + 1);
    const books = files.filter((e) => formatOf(nameOf(e)));
    const wanted = books.filter((e) => formatOf(nameOf(e)) !== "txt");
    const candidates = wanted.length ? wanted : books;

    if (!candidates.length) {
      const asIs = files.some((e) => e.name === "mimetype") && files.some((e) => e.name === "META-INF/container.xml") ? "epub" : files.length && files.every((e) => /\.(jpe?g|png|gif|webp)$/i.test(e.name)) ? "cbz" : null;
      if (!asIs) throw new ImportError("archive-empty");
      const slot = this.editor.reserve(folder, name, asIs);
      spare.push(slot.temp);
      renameSync(zip, slot.temp);
      return { slot, ext: asIs };
    }
    if (candidates.length > 1) throw new ImportError("archive-many");
    const entry = candidates[0]!;
    const inner = nameOf(entry);
    const ext = inner.slice(inner.lastIndexOf(".") + 1).toLowerCase();
    const slot = this.editor.reserve(folder, name, ext);
    spare.push(slot.temp);
    await extractEntry(zip, entry, slot.temp, this.maxBytes).catch(fail);
    return { slot, ext };
  }

  private view(job: Running): ImportJob {
    const { abort: _abort, finished: _finished, keep: _keep, ...rest } = job;
    return rest;
  }

  job(id: string): ImportJob | null {
    const job = this.jobs.get(id);
    return job ? this.view(job) : null;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return false;
    job.abort.abort();
    return true;
  }

  private sweep(): void {
    for (const [id, job] of this.jobs) if (job.finished && Date.now() - job.finished > KEEP_MS) this.jobs.delete(id);
  }
}

/**
 * Google, or (for the browser tests only, which must never reach the real Drive) a stand-in server
 * named by TAPALOG_IMPORT_TEST_URL, if that is on this computer.
 */
export function driveEndpoints(testUrl = process.env.TAPALOG_IMPORT_TEST_URL): DriveEndpoints {
  if (!testUrl) return GOOGLE;
  const base = new URL(testUrl);
  if (base.hostname !== "127.0.0.1" && base.hostname !== "localhost") return GOOGLE;
  return {
    download: (id) => `${base.origin}/download?id=${id}`,
    thumbnail: (id) => `${base.origin}/thumbnail?id=${id}`,
    trusted: (url) => url.origin === base.origin,
    local: base.origin,
  };
}
