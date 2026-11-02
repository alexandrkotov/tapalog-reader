import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { LinkImports, driveEndpoints, fileNameFrom, parseLink, suggestName, type ImportJob } from "./linkImport";
import { LibraryEditor } from "./editor";
import { startFakeDrive } from "./fakeDrive";
import { Library } from "./library";
import { removeDir } from "./testutil";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456";
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

const driveId = (text: string) => parseLink(text).drive;

test("the file id comes out of every form of a Drive link", () => {
  for (const link of [
    `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
    `https://drive.google.com/file/d/${ID}/view?fbclid=abc`,
    `https://drive.google.com/open?id=${ID}&usp=drive_fs`,
    `https://drive.google.com/uc?export=download&id=${ID}`,
    `https://drive.google.com/u/1/file/d/${ID}/edit`,
    `  https://drive.google.com/open?id=${ID}\n`,
    `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
  ]) {
    expect(driveId(link)).toBe(ID);
  }
});

test("a link wrapped in a Facebook redirect is unwrapped, and the wrapper itself is never what is requested", () => {
  const inner = encodeURIComponent(`https://drive.google.com/open?id=${ID}&usp=drive_fs&fbclid=IwZXh0`);
  expect(driveId(`https://l.facebook.com/l.php?u=${inner}&h=AUBwnurAdZkj&__tn__=R]-R&c[0]=AUAufG4u`)).toBe(ID);
  const toElsewhere = encodeURIComponent("https://example.org/books/a.pdf");
  expect(parseLink(`https://l.facebook.com/l.php?u=${toElsewhere}`).url?.href).toBe("https://example.org/books/a.pdf");
  expect(code(() => parseLink("https://l.facebook.com/l.php"))).toBe("bad-link");
});

test("a link to any other site is kept as it is, and what is not a link to a file is told apart", () => {
  expect(parseLink("https://example.org/library/book.pdf?x=1").url?.href).toBe("https://example.org/library/book.pdf?x=1");
  expect(parseLink("http://example.org/a.epub").url?.protocol).toBe("http:");
  expect(parseLink(`https://drive.google.com.evil.example/file/d/${ID}/view`).drive).toBeUndefined(); // an ordinary site, not Drive
  expect(code(() => parseLink("hello"))).toBe("bad-link");
  expect(code(() => parseLink("ftp://example.org/a.pdf"))).toBe("bad-link");
  expect(code(() => parseLink("file:///etc/passwd"))).toBe("bad-link");
  expect(code(() => parseLink("javascript:alert(1)"))).toBe("bad-link");
  expect(code(() => parseLink("https://user:secret@example.org/a.pdf"))).toBe("bad-link");
  expect(code(() => parseLink("https://drive.google.com/file/d/short/view"))).toBe("bad-link");
  expect(code(() => parseLink("https://drive.google.com/open?id="))).toBe("bad-link");
  expect(code(() => parseLink(`https://drive.google.com/drive/folders/${ID}`))).toBe("folder");
  expect(code(() => parseLink(`https://docs.google.com/document/d/${ID}/edit`))).toBe("not-a-file");
  expect(code(() => parseLink(`https://docs.google.com/spreadsheets/d/${ID}/edit`))).toBe("not-a-file");
});

test("a name that arrives as UTF-8 bytes in a Latin-1 header is read back, and the extension-less name is made safe", () => {
  const utf8 = "Лучшие конструкции, 1957.pdf";
  const asHeader = String.fromCharCode(...new TextEncoder().encode(utf8));
  expect(fileNameFrom(`attachment; filename="${asHeader}"`)).toBe(utf8);
  expect(fileNameFrom(`attachment; filename*=UTF-8''${encodeURIComponent(utf8)}`)).toBe(utf8);
  expect(fileNameFrom(`attachment; filename="plain.epub"`)).toBe("plain.epub");
  expect(fileNameFrom(`attachment; filename="Ünïcode.pdf"`)).toBe("Ünïcode.pdf");
  expect(fileNameFrom(null)).toBeNull();
  expect(suggestName('Radio: "the best" / 1957?')).toBe("Radio the best 1957");
  expect(suggestName("..hidden. ")).toBe("hidden");
  expect(suggestName(":::")).toBe("Book");
});

test("the test hook only ever points at this computer", () => {
  expect(driveEndpoints("http://127.0.0.1:9999").download("x")).toBe("http://127.0.0.1:9999/download?id=x");
  expect(driveEndpoints("http://evil.example").download("x")).toStartWith("https://drive.usercontent.google.com/");
  expect(driveEndpoints(undefined).trusted(new URL("https://lh3.googleusercontent.com/d/x"))).toBe(true);
  expect(driveEndpoints(undefined).trusted(new URL("https://evil.example/"))).toBe(false);
  expect(driveEndpoints(undefined).trusted(new URL("http://drive.google.com/"))).toBe(false);
});

// ---------- the import itself, against a stand-in for Drive ----------

const base = mkdtempSync(join(tmpdir(), "reader-drive-"));
const opened: { close(): void }[] = [];
afterAll(() => {
  for (const x of opened) x.close();
  removeDir(base);
});

const PDF = new TextEncoder().encode("%PDF-1.5 " + "page ".repeat(2000));
const drive = startFakeDrive({
  [ID]: { name: "Лучшие конструкции, 1957.pdf", content: PDF },
  BOOKTXT123456: { name: "notes.txt", content: "just text" },
  WRONGCONTENT1: { name: "fake.pdf", content: "<!doctype html><html>Sign in</html>" },
  NOTPDFBYTES12: { name: "fake2.pdf", content: "this is plain text, not a PDF" },
  MOVIE12345678: { name: "film.mp4", content: "xxxx" },
  URLBOOK: { name: null, content: PDF },
  NOEXTENSION: { name: null, content: PDF, type: "application/pdf" },
  NOWHERE1: { name: null, content: PDF, type: "application/octet-stream" },
  WEBPAGE: { name: null, content: "<!doctype html><title>A page</title>", type: "text/html" },
  IGNORERANGE: { name: "norange.pdf", content: PDF, ignoreRange: true },
  UNKNOWNSIZE: { name: "chunked.pdf", content: PDF, chunked: true },
  SLOWBOOK12345: { name: "slow.pdf", content: new Uint8Array([...new TextEncoder().encode("%PDF-")].concat(Array(5000).fill(32))), slow: { chunk: 500, everyMs: 50 } },
});
afterAll(() => drive.stop());

let lib: string;
let imports: LinkImports;
let library: Library;
let n = 0;

beforeEach(async () => {
  const dir = join(base, String(n++));
  lib = join(dir, "lib");
  const data = join(lib, "tapalog-reader-data");
  mkdirSync(join(lib, "Radio"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(lib, "taken.pdf"), "x");
  const db = openDb(dir);
  library = new Library(db, new ConfigStore(dir), data);
  opened.push(db, library);
  await library.setRoot(lib);
  imports = new LinkImports(library, new LibraryEditor(library, data), drive.endpoints, 20_000);
});
afterEach(() => {
  drive.hits.length = 0;
});

const finished = async (job: ImportJob): Promise<ImportJob> => {
  for (let i = 0; i < 100; i++) {
    const now = imports.job(job.id)!;
    if (now.state !== "running") return now;
    await Bun.sleep(50);
  }
  throw new Error("the import did not finish");
};
const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;
const at = (id: string, name = "") => `${drive.origin}/files/${id}/${name}`;
const refused = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "no error";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

test("inspecting a file gives its name, format and size without downloading it", async () => {
  expect(await imports.inspect(link(ID))).toEqual({ id: ID, name: "Лучшие конструкции, 1957", ext: "pdf", size: PDF.length });
  expect(await imports.thumbnail(ID)).toMatchObject({ type: "image/png" });
  expect(await imports.thumbnail("MOVIE12345678")).not.toBeNull();
  expect(await imports.thumbnail("NOSUCHFILE123")).toBeNull();
  expect(await imports.thumbnail("../etc/passwd")).toBeNull();
  expect(drive.hits.filter((h) => h.startsWith("/download"))).toHaveLength(1); // one request for a byte, never the whole file
});

test("a link to a file on any site is inspected and saved like a Drive one, named after the address when the server gives no name", async () => {
  expect(await imports.inspect(at("URLBOOK", "Radio%20Book%201950.pdf?download=1"))).toEqual({ id: null, name: "Radio Book 1950", ext: "pdf", size: PDF.length });
  expect(await imports.inspect(at("NOEXTENSION", "download"))).toEqual({ id: null, name: "download", ext: "pdf", size: PDF.length }); // the content type says what it is
  expect(await imports.inspect(at("IGNORERANGE"))).toMatchObject({ name: "norange", size: PDF.length }); // a server that sends everything for a one-byte request
  expect(await imports.inspect(at("UNKNOWNSIZE"))).toMatchObject({ name: "chunked", size: 0 }); // no length given
  expect(await refused(() => imports.inspect(at("NOWHERE1", "thing")))).toBe("unsupported");
  const job = await finished(await imports.start(at("URLBOOK", "x.pdf"), "Radio", "From a site"));
  expect(job).toMatchObject({ state: "done", path: "Radio/From a site.pdf", received: PDF.length });
  expect(readFileSync(join(lib, "Radio/From a site.pdf"))).toEqual(Buffer.from(PDF));
  const unknown = await finished(await imports.start(at("UNKNOWNSIZE"), "", "no length", true));
  expect(unknown).toMatchObject({ state: "done", path: "no length.pdf", received: PDF.length, total: 0 });
});

test("a link that leads into this computer or its network is never followed", async () => {
  const hits = drive.hits.length;
  for (const inside of ["http://127.0.0.1:1/a.pdf", "http://localhost:1/a.pdf", "http://[::1]:1/a.pdf", "http://10.0.0.5/a.pdf", "http://192.168.1.1/a.pdf", "http://169.254.169.254/latest/a.pdf", "http://2130706433/a.pdf", "http://0x7f.1/a.pdf", "http://[::ffff:127.0.0.1]/a.pdf", "http://0.0.0.0/a.pdf"]) {
    expect(await refused(() => imports.inspect(inside))).toBe("local-address");
    expect(await refused(() => imports.start(inside, "", "x"))).toBe("local-address");
  }
  expect(await refused(() => imports.inspect(at("TOMETADATA", "a.pdf")))).toBe("local-address"); // a redirect on a friendly site to an address inside
  expect(await refused(() => imports.inspect(at("TOLOCALHOST", "a.pdf")))).toBe("local-address"); // a name that resolves to this computer
  expect(drive.hits.length).toBe(hits + 2); // only the two friendly requests were made
  expect(readdirSync(lib).filter((f) => f.startsWith("."))).toEqual([]);
});

test("a page, a missing file, a refusal and a redirect loop are told apart", async () => {
  expect(await refused(() => imports.inspect(at("WEBPAGE", "a.pdf")))).toBe("web-page");
  expect(await refused(() => imports.inspect(at("NOSUCHFILE", "a.pdf")))).toBe("not-found");
  expect(await refused(() => imports.inspect(at("FORBIDDEN", "a.pdf")))).toBe("closed");
  expect(await refused(() => imports.inspect(at("LOOP", "a.pdf")))).toBe("failed");
  expect(await refused(() => imports.inspect("https://example.invalid/a.pdf"))).toBe("unreachable");
});

test("a book is saved under the chosen name in the chosen folder, listed at once, with no leftovers", async () => {
  const job = await finished(await imports.start(link(ID), "Radio", "Конструкции 1957"));
  expect(job).toMatchObject({ state: "done", path: "Radio/Конструкции 1957.pdf", received: PDF.length, total: PDF.length, error: null });
  expect(readFileSync(join(lib, "Radio/Конструкции 1957.pdf"))).toEqual(Buffer.from(PDF));
  expect(library.bookAt("Radio/Конструкции 1957.pdf")?.id).toBe(job.bookId!);
  expect(readdirSync(join(lib, "Radio"))).toEqual(["Конструкции 1957.pdf"]); // the hidden download file is gone
});

test("the root folder is where it goes by default, and a plain text book has no format check beyond not being a web page", async () => {
  const job = await finished(await imports.start(link("BOOKTXT123456"), "", "notes"));
  expect(job).toMatchObject({ state: "done", path: "notes.txt" });
  expect(existsSync(join(lib, "notes.txt"))).toBe(true);
});

test("a refusal comes before anything is downloaded", async () => {
  expect(await refused(() => imports.start(link(ID), "Radio", "x/y"))).toBe("invalid-name");
  expect(await refused(() => imports.start(link(ID), "NoSuchFolder", "x"))).toBe("missing");
  expect(await refused(() => imports.start(link(ID), "", "taken"))).toBe("exists");
  expect(await refused(() => imports.start(link("MOVIE12345678"), "", "film"))).toBe("unsupported");
  expect(await refused(() => imports.start(link("NOSUCHFILE123"), "", "x"))).toBe("not-found");
  expect(await refused(() => imports.start(link("CLOSEDFILE"), "", "x"))).toBe("closed");
  expect(await refused(() => imports.start("not a link", "", "x"))).toBe("bad-link");
  expect(readdirSync(lib).filter((f) => f.startsWith("."))).toEqual([]);
});

test("a book the library already has, under any name and in any folder, is not saved again unless asked", async () => {
  writeFileSync(join(lib, "Radio", "already here.pdf"), PDF);
  await library.rescan();
  const job = await finished(await imports.start(link(ID), "", "same book, other name"));
  expect(job).toMatchObject({ state: "failed", error: "duplicate", duplicateOf: "Radio/already here.pdf", path: null });
  expect(readdirSync(lib).sort()).toEqual(["Radio", "taken.pdf", "tapalog-reader-data"]); // the download was thrown away
  expect(readdirSync(join(lib, "Radio"))).toEqual(["already here.pdf"]);

  const kept = await finished(await imports.start(link(ID), "", "same book, other name", true));
  expect(kept).toMatchObject({ state: "done", path: "same book, other name.pdf", duplicateOf: null });
  const other = await finished(await imports.start(link("BOOKTXT123456"), "", "a different book")); // not a duplicate of anything
  expect(other.state).toBe("done");
});

test("a download that is not the book it claims to be is thrown away", async () => {
  for (const id of ["WRONGCONTENT1", "NOTPDFBYTES12"]) {
    const job = await finished(await imports.start(link(id), "", "bad-" + id));
    expect(job).toMatchObject({ state: "failed", error: "wrong-content" });
  }
  expect(readdirSync(lib).sort()).toEqual(["Radio", "taken.pdf", "tapalog-reader-data"]);
});

test("a file bigger than the limit is refused before it is fetched", async () => {
  const small = new LinkImports(library, new LibraryEditor(library, join(lib, "tapalog-reader-data")), drive.endpoints, 100);
  expect(await refused(() => small.start(link(ID), "", "big"))).toBe("too-big");
});

test("a redirect to any other host is not followed", async () => {
  const evil = startFakeDrive({});
  try {
    expect(await refused(() => imports.inspect(link("EVILREDIRECT")))).toBe("unreachable");
  } finally {
    evil.stop();
  }
});

test("a running download can be cancelled and leaves nothing behind", async () => {
  const job = await imports.start(link("SLOWBOOK12345"), "", "slow");
  await Bun.sleep(150);
  expect(imports.job(job.id)).toMatchObject({ state: "running" });
  expect(imports.cancel(job.id)).toBe(true);
  expect(await finished(job)).toMatchObject({ state: "failed", error: "cancelled" });
  expect(readdirSync(lib).sort()).toEqual(["Radio", "taken.pdf", "tapalog-reader-data"]);
  expect(imports.cancel(job.id)).toBe(false);
  expect(imports.job("nope")).toBeNull();
});

test("a name that turns up while the book downloads is not overwritten", async () => {
  const job = await imports.start(link("SLOWBOOK12345"), "", "slow");
  writeFileSync(join(lib, "slow.pdf"), "somebody else's file");
  expect(await finished(job)).toMatchObject({ state: "failed", error: "exists" });
  expect(readFileSync(join(lib, "slow.pdf"), "utf-8")).toBe("somebody else's file");
});
