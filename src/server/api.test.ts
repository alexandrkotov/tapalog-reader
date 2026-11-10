import { afterAll, beforeAll, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { Backup } from "./backup";
import { DisplayStore } from "./display";
import { Projects } from "./projects";
import { ProgressStore } from "./progress";
import { Bookmarks } from "./bookmarks";
import { Covers } from "./covers";
import { LinkImports } from "./linkImport";
import { startFakeDrive } from "./fakeDrive";
import { LibraryEditor } from "./editor";
import { FullText } from "./fulltext";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { Library } from "./library";
import { startServers, type Servers } from "./server";
import { Shares } from "./shares";
import { Plugins } from "./plugins";
import { Sources } from "./sources";
import { Recovery } from "./recovery";
import { removeDir } from "./testutil";
import { TunnelController } from "./tunnelController";

let lib: string;
let data: string;
let pluginsDir: string;
let servers: Servers;
const PDF = "%PDF-1.4 a book fetched from the stand-in Drive";
const drive = startFakeDrive({ ABCDEFGHIJKLMNOP: { name: "Fetched book.pdf", content: PDF } });
let db: ReturnType<typeof openDb>;
let library: Library;
let lan: string;
let tunnelSide: string; // the loopback socket the internet tunnel forwards to
const modes: string[] = [];
const stops: number[] = [];

beforeAll(async () => {
  lib = mkdtempSync(join(tmpdir(), "reader-api-lib-"));
  data = mkdtempSync(join(tmpdir(), "reader-api-data-"));
  pluginsDir = mkdtempSync(join(tmpdir(), "reader-api-plugins-"));
  mkdirSync(join(pluginsDir, "demo", "assets"), { recursive: true });
  writeFileSync(join(pluginsDir, "demo", "plugin.json"), JSON.stringify({ id: "demo", name: "Demo reader", version: "1.2.3", formats: [{ ext: ["demo", "dmo"], mime: "application/x-demo" }], reader: "reader.js", shareableView: true }));
  writeFileSync(join(pluginsDir, "demo", "reader.js"), "export function mount() {}\n");
  writeFileSync(join(pluginsDir, "demo", "assets", "data.txt"), "plugin data");
  mkdirSync(join(pluginsDir, "sealed"));
  writeFileSync(join(pluginsDir, "sealed", "plugin.json"), JSON.stringify({ id: "sealed", name: "Sealed reader", api: 2, isolated: true, formats: [{ ext: "seal" }], reader: "reader.js" }));
  writeFileSync(join(pluginsDir, "sealed", "reader.js"), "export function mount() {}\n");
  writeFileSync(join(pluginsDir, "secret.txt"), "not for the web");
  mkdirSync(join(pluginsDir, "broken"));
  writeFileSync(join(pluginsDir, "broken", "plugin.json"), "{ nope");
  mkdirSync(join(lib, "sub"));
  writeFileSync(join(lib, "one.txt"), "first book, 0123456789");
  writeFileSync(join(lib, "sub/two.txt"), "second book");
  writeFileSync(join(lib, "sub/three.pdf"), "%PDF-1.4 not really a pdf, covers are drawn by the browser");
  db = openDb(data);
  const config = new ConfigStore(data);
  library = new Library(db, config, data);
  await library.setRoot(lib);
  const auth = new Auth(db);
  const editor = new LibraryEditor(library, data);
  servers = startServers(
    { library, auth, recovery: new Recovery(data, auth), shares: new Shares(db), config, covers: new Covers(data), bookmarks: new Bookmarks(db), progress: new ProgressStore(db), projects: new Projects(db), display: new DisplayStore(db), backup: new Backup(db, config), sources: new Sources(db), plugins: new Plugins(pluginsDir), editor, linkImports: new LinkImports(library, editor, drive.endpoints), fullText: new FullText(data, library, config), tunnel: new TunnelController(() => "http://127.0.0.1:1"), lanUrls: () => [], setMode: (m) => modes.push(m), stop: () => void stops.push(1) },
    { hostname: "127.0.0.1", port: 0 },
  );
  lan = `http://127.0.0.1:${servers.lan.port}`;
  tunnelSide = `http://127.0.0.1:${servers.internal.port}`;
});
afterAll(() => {
  drive.stop();
  servers.stop();
  library.close();
  db.close();
  removeDir(lib);
  removeDir(data);
  removeDir(pluginsDir);
});

async function call(base: string, path: string, opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON: a file */
  }
  return { status: res.status, body: parsed, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

let adminCookie = "";
let userCookie = "";
let bookId = "";

test("before setup the local network can browse, the internet side cannot, and setup is local-only", async () => {
  expect((await call(lan, "/api/me")).body).toMatchObject({ setupNeeded: true, setupPossible: true, canBrowse: true });
  const library = await call(lan, "/api/library");
  expect(library.status).toBe(200);
  const one = library.body.books.find((b: { name: string }) => b.name === "one");
  bookId = one.id;
  expect(one.added).toBeGreaterThan(0); // when the library first saw the file: what the shelf orders "date added" by

  expect((await call(tunnelSide, "/api/library")).status).toBe(401);
  expect((await call(tunnelSide, "/api/me")).body).toMatchObject({ origin: "tunnel", setupPossible: false, canBrowse: false });
  expect((await call(tunnelSide, "/api/setup", { body: { name: "mallory", password: "hunter22" } })).status).toBe(403);
});

test("the first administrator is created, signed in, and a second setup is refused", async () => {
  const setup = await call(lan, "/api/setup", { body: { name: "Alex", password: "secret1" } });
  expect(setup.status).toBe(200);
  expect(setup.cookie).toStartWith("sid=");
  adminCookie = setup.cookie!;
  expect((await call(lan, "/api/me", { cookie: adminCookie })).body.user).toMatchObject({ name: "Alex", role: "admin" });
  expect((await call(lan, "/api/setup", { body: { name: "Other", password: "secret1" } })).status).toBe(403);
});

test("login checks the password, names are case-insensitive, repeated failures lock the account for that visitor", async () => {
  expect((await call(lan, "/api/login", { body: { name: "alex", password: "secret1" } })).status).toBe(200);
  for (let i = 0; i < 5; i++) expect((await call(lan, "/api/login", { body: { name: "alex", password: "wrong" + i } })).status).toBe(401);
  expect((await call(lan, "/api/login", { body: { name: "alex", password: "secret1" } })).status).toBe(429);
  // another visitor's attempts are unaffected (here: the same name from the tunnel side is a different key)
  expect((await call(tunnelSide, "/api/login", { body: { name: "alex", password: "secret1" }, headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(200);
});

test("registration works on the local network only, and only when allowed", async () => {
  const reg = await call(lan, "/api/register", { body: { name: "Reader", password: "pin123" } });
  expect(reg.status).toBe(200);
  userCookie = reg.cookie!;
  expect((await call(lan, "/api/register", { body: { name: "reader", password: "pin123" } })).status).toBe(409);
  expect((await call(tunnelSide, "/api/register", { body: { name: "Remote", password: "pin123" } })).status).toBe(403);
});

test("admin routes need an administrator", async () => {
  expect((await call(lan, "/api/admin/settings")).status).toBe(401);
  expect((await call(lan, "/api/admin/settings", { cookie: userCookie })).status).toBe(403);
  expect((await call(lan, "/api/rescan", { method: "POST", body: {}, cookie: userCookie })).status).toBe(403);
  expect((await call(lan, "/api/admin/settings", { cookie: adminCookie })).body).toMatchObject({ lanAccess: "open", mode: "lan" });
});

test("state-changing requests must be JSON from the same origin", async () => {
  const form = await fetch(lan + "/api/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=alex&password=secret1" });
  expect(form.status).toBe(400);
  const foreign = await call(lan, "/api/login", { body: { name: "Reader", password: "pin123" }, headers: { Origin: "https://evil.example" } });
  expect(foreign.status).toBe(400);
});

test("requiring sign-in on the local network closes the library to anonymous visitors", async () => {
  await call(lan, "/api/admin/settings", { body: { lanAccess: "login" }, cookie: adminCookie });
  expect((await call(lan, "/api/library")).status).toBe(401);
  expect((await call(lan, "/api/library", { cookie: userCookie })).status).toBe(200);
  expect((await call(lan, "/api/shares", { body: { bookId }, cookie: "" })).status).toBe(401);
  await call(lan, "/api/admin/settings", { body: { lanAccess: "open" }, cookie: adminCookie });
});

test("a share link opens exactly one book, with its view, without signing in", async () => {
  const view = { v: 1, page: 3, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
  const made = await call(lan, "/api/shares", { body: { bookId, view, expiresInDays: 7 }, cookie: userCookie });
  expect(made.status).toBe(200);
  expect(made.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const token = made.body.token as string;

  // the visitor comes through the internet tunnel and has no account
  const meta = await call(tunnelSide, `/api/share/${token}`);
  expect(meta.body).toMatchObject({ name: "one", ext: "txt", view });
  const file = await call(tunnelSide, `/api/share/${token}/file`, { headers: { Range: "bytes=0-4" } });
  expect(file.status).toBe(206);
  expect(file.body).toBe("first");

  // ...but that token doesn't open the rest of the library
  expect((await call(tunnelSide, `/api/file/${bookId}`)).status).toBe(401);
  expect((await call(tunnelSide, "/api/library")).status).toBe(401);
  expect((await call(tunnelSide, "/api/share/not-a-real-token")).status).toBe(404);

  // only the owner or an admin can revoke
  expect((await call(lan, `/api/shares/${token}`, { method: "DELETE", cookie: "" })).status).toBe(403);
  expect((await call(lan, `/api/shares/${token}`, { method: "DELETE", cookie: userCookie })).status).toBe(200);
  expect((await call(tunnelSide, `/api/share/${token}`)).status).toBe(404);
});

test("an expired link stops working and a rejected view is not stored", async () => {
  const made = await call(lan, "/api/shares", { body: { bookId }, cookie: adminCookie });
  expect(made.status).toBe(200);
  expect((await call(tunnelSide, `/api/share/${made.body.token}`)).status).toBe(200);
  db.query("UPDATE shares SET expires_at = ? WHERE token = ?").run(Date.now() - 1000, made.body.token);
  expect((await call(tunnelSide, `/api/share/${made.body.token}`)).status).toBe(404);
  expect((await call(tunnelSide, `/api/share/${made.body.token}/file`)).status).toBe(404);
  expect((await call(lan, "/api/shares", { body: { bookId: "nope" }, cookie: adminCookie })).status).toBe(400);
  expect((await call(lan, "/api/shares", { body: { bookId, view: "x".repeat(10) }, cookie: adminCookie })).status).toBe(400);
  expect((await call(lan, "/api/shares", { body: { bookId, view: { blob: "x".repeat(5000) } }, cookie: adminCookie })).status).toBe(400);
});

test("the last administrator cannot be removed and internet mode is switched through the app", async () => {
  const users = (await call(lan, "/api/admin/settings", { cookie: adminCookie })).body.users as { id: number; name: string }[];
  const alex = users.find((u) => u.name === "Alex")!;
  expect((await call(lan, `/api/admin/users/${alex.id}`, { method: "DELETE", cookie: adminCookie })).status).toBe(400);
  await call(lan, "/api/admin/settings", { body: { mode: "internet" }, cookie: adminCookie });
  expect(modes).toEqual(["internet"]);
});

test("a changed password signs that account out everywhere", async () => {
  const users = (await call(lan, "/api/admin/settings", { cookie: adminCookie })).body.users as { id: number; name: string }[];
  const reader = users.find((u) => u.name === "Reader")!;
  expect((await call(lan, `/api/admin/users/${reader.id}/password`, { body: { password: "newpin9" }, cookie: adminCookie })).status).toBe(200);
  expect((await call(lan, "/api/me", { cookie: userCookie })).body.user).toBeNull();
  expect((await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).status).toBe(200);
});

test("a forgotten administrator password is reset with a code from a file in the data folder, on the local network only", async () => {
  const file = join(data, "reset-code.txt");
  const finish = (body: object, base = lan) => call(base, "/api/recover/finish", { body });
  expect((await call(lan, "/api/me")).body.canRecover).toBe(true);
  expect((await call(tunnelSide, "/api/me")).body.canRecover).toBe(false);
  expect((await call(tunnelSide, "/api/recover/start", { body: {} })).status).toBe(403);
  expect(existsSync(file)).toBe(false);

  expect((await call(lan, "/api/recover/start", { body: {} })).body).toEqual({ ok: true, file: "reset-code.txt", path: file }); // asked from the computer itself
  const code = readFileSync(file, "utf-8").match(/\d{4}-\d{4}/)![0];
  await call(lan, "/api/recover/start", { body: {} });
  expect(readFileSync(file, "utf-8")).toContain(code); // asking again keeps the code

  expect((await finish({ name: "Alex", code, password: "no" })).status).toBe(400);
  expect((await finish({ name: "Reader", code, password: "fresh-secret" })).status).toBe(401); // only an administrator
  expect((await finish({ name: "Alex", code, password: "fresh-secret" }, tunnelSide)).status).toBe(403);
  const done = await finish({ name: "alex", code, password: "fresh-secret" });
  expect(done.status).toBe(200);
  expect(done.body.user).toMatchObject({ name: "Alex", role: "admin" });
  expect(existsSync(file)).toBe(false);

  expect((await call(lan, "/api/me", { cookie: adminCookie })).body.user).toBeNull(); // the old sessions are gone
  adminCookie = done.cookie!;
  expect((await call(lan, "/api/me", { cookie: adminCookie })).body.user).toMatchObject({ name: "Alex" });
  expect((await call(tunnelSide, "/api/login", { body: { name: "Alex", password: "fresh-secret" }, headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
  expect((await finish({ name: "Alex", code, password: "again-1234" })).status).toBe(401); // a used code is dead
});

test("cover thumbnails are uploaded by the administrator, stored per book and served to readers", async () => {
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!; // the password test above changed it
  const pdf = (await call(lan, "/api/library")).body.books.find((b: { name: string }) => b.name === "three") as { id: string; cover?: boolean };
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(300).fill(7)]);
  const put = (id: string, init: { cookie?: string; type?: string; body?: BodyInit; headers?: Record<string, string> }) =>
    fetch(`${lan}/api/admin/covers/${id}`, { method: "PUT", headers: { "Content-Type": init.type ?? "image/jpeg", ...(init.cookie ? { Cookie: init.cookie } : {}), ...init.headers }, body: init.body ?? jpeg });

  // only a book with something to show is on the to-do list, and only the administrator sees it
  expect((await call(lan, "/api/admin/covers/todo", { cookie: readerCookie })).status).toBe(403);
  expect((await call(lan, "/api/admin/covers/todo", { cookie: adminCookie })).body).toEqual({ todo: [{ id: pdf.id, ext: "pdf", size: expect.any(Number) }], remaining: 1 });

  expect((await put(pdf.id, {})).status).toBe(401);
  expect((await put(pdf.id, { cookie: readerCookie })).status).toBe(403);
  expect((await put(pdf.id, { cookie: adminCookie, type: "text/plain" })).status).toBe(400);
  expect((await put(pdf.id, { cookie: adminCookie, headers: { Origin: "https://evil.example" } })).status).toBe(400);
  expect((await put(pdf.id, { cookie: adminCookie, body: new TextEncoder().encode("<html>not a jpeg, long enough to pass the size check....................................................................") })).status).toBe(400);
  expect((await put(pdf.id, { cookie: adminCookie, body: new Uint8Array(500 * 1024).fill(0xff) })).status).toBe(400);
  expect((await put(bookId, { cookie: adminCookie })).status).toBe(400); // a .txt has no cover

  expect((await call(lan, `/api/cover/${pdf.id}`)).status).toBe(404);
  expect((await put(pdf.id, { cookie: adminCookie })).status).toBe(200);
  const served = await fetch(`${lan}/api/cover/${pdf.id}`);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg);
  expect((await call(lan, "/api/library")).body.books.find((b: { id: string }) => b.id === pdf.id).cover).toBe(true);
  expect((await call(lan, "/api/search?q=three")).body.books[0].cover).toBe(true);
  expect((await call(tunnelSide, `/api/cover/${pdf.id}`)).status).toBe(401);
  expect((await call(lan, "/api/admin/covers/todo", { cookie: adminCookie })).body.remaining).toBe(0);
});

test("a book the browser could not draw is marked so it is not tried again", async () => {
  writeFileSync(join(lib, "broken.pdf"), "%PDF-1.4 broken");
  await call(lan, "/api/rescan", { method: "POST", body: {}, cookie: adminCookie });
  await Bun.sleep(400);
  const todo = (await call(lan, "/api/admin/covers/todo", { cookie: adminCookie })).body.todo as { id: string }[];
  expect(todo).toHaveLength(1);
  expect((await call(lan, `/api/admin/covers/${todo[0]!.id}`, { body: {}, cookie: adminCookie })).status).toBe(200);
  expect((await call(lan, "/api/admin/covers/todo", { cookie: adminCookie })).body.todo).toEqual([]);
});

test("search inside books is off until the administrator turns it on, and only the administrator can", async () => {
  expect((await call(lan, "/api/admin/fulltext", { cookie: "" })).status).toBe(401);
  expect((await call(lan, "/api/admin/fulltext", { body: { enabled: true } })).status).toBe(401);
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  expect((await call(lan, "/api/admin/fulltext", { cookie: readerCookie })).status).toBe(403);
  expect((await call(lan, "/api/admin/fulltext", { body: { enabled: true }, cookie: readerCookie })).status).toBe(403);
  expect((await call(lan, "/api/admin/fulltext", { body: { enabled: "yes" }, cookie: adminCookie })).status).toBe(400);

  expect((await call(lan, "/api/fulltext?q=first")).body).toEqual({ enabled: false, books: [], progress: { enabled: false, done: 0, total: 4 } });
  expect((await call(lan, "/api/fulltext/state")).body).toEqual({ enabled: false, done: 0, total: 4 }); // a reader can see how far the reading of the books has got
  expect((await call(lan, "/api/status")).body.fullText).toBe(false);

  expect((await call(lan, "/api/admin/fulltext", { body: { enabled: true }, cookie: adminCookie })).body.enabled).toBe(true);
  expect((await call(lan, "/api/status")).body.fullText).toBe(true);
  let found: { books: { name: string; hits: { snippet: string; view: unknown; loc: unknown }[] }[] } = { books: [] };
  for (let i = 0; i < 200 && !found.books.length; i++) {
    await Bun.sleep(100); // indexing runs in the background; a slow runner needs seconds, not milliseconds
    found = (await call(lan, "/api/fulltext?q=second")).body;
  }
  expect(found.books[0]).toMatchObject({ name: "two", hits: [{ view: { v: 1, offset: 0, range: [0, 6] } }] });
  expect(found.books[0]!.hits[0]!.snippet).toBe("\u0001second\u0002 book");
  expect(found.books[0]!.hits[0]!.loc).toEqual({ offset: 0 }); // where in the book: the page's label next to the text
  expect((await call(tunnelSide, "/api/fulltext?q=second")).status).toBe(401); // the internet side still needs a sign-in

  await call(lan, "/api/admin/fulltext", { body: { enabled: false }, cookie: adminCookie });
}, 30_000);

test("a book is fetched from a shared Drive link by the administrator only, into the folder they choose", async () => {
  const link = encodeURIComponent("https://drive.google.com/open?id=ABCDEFGHIJKLMNOP&usp=drive_fs");
  const wrapped = `https://l.facebook.com/l.php?u=${link}&h=tracking`;
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  for (const cookie of ["", readerCookie]) {
    expect((await call(lan, "/api/admin/import/inspect", { body: { link: wrapped }, cookie })).status).toBe(cookie ? 403 : 401);
    expect((await call(lan, "/api/admin/import", { body: { link: wrapped, folder: "", name: "x" }, cookie })).status).toBe(cookie ? 403 : 401);
    expect((await call(lan, "/api/admin/import/thumbnail/ABCDEFGHIJKLMNOP", { cookie })).status).toBe(cookie ? 403 : 401);
  }

  expect((await call(lan, "/api/admin/import/inspect", { body: { link: wrapped }, cookie: adminCookie })).body).toEqual({ id: "ABCDEFGHIJKLMNOP", name: "Fetched book", ext: "pdf", size: PDF.length, archive: false });
  expect((await call(lan, "/api/admin/import/inspect", { body: { link: "ftp://example.com/x.pdf" }, cookie: adminCookie })).body).toEqual({ error: "bad-link" });
  expect((await call(lan, "/api/admin/import/inspect", { body: { link: "http://127.0.0.1:1/x.pdf" }, cookie: adminCookie })).body).toEqual({ error: "local-address" }); // the program cannot be pointed at its own computer
  expect((await call(lan, "/api/admin/import/inspect", { body: { link: "http://192.168.0.1/admin.pdf" }, cookie: adminCookie })).body).toEqual({ error: "local-address" });
  const picture = await fetch(lan + "/api/admin/import/thumbnail/ABCDEFGHIJKLMNOP", { headers: { Cookie: adminCookie } });
  expect([picture.status, picture.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect((await call(lan, "/api/admin/import/thumbnail/NOSUCHFILE1234", { cookie: adminCookie })).status).toBe(404);

  expect((await call(lan, "/api/admin/import", { body: { link: wrapped, folder: "nowhere", name: "Fetched" }, cookie: adminCookie })).body).toEqual({ error: "missing" });
  const started = await call(lan, "/api/admin/import", { body: { link: wrapped, folder: "sub", name: "Fetched" }, cookie: adminCookie });
  expect(started.status).toBe(200);
  const jobId = started.body.job.id as string;
  let job = started.body.job;
  for (let i = 0; i < 100 && job.state === "running"; i++) {
    await Bun.sleep(50);
    job = (await call(lan, `/api/admin/import/${jobId}`, { cookie: adminCookie })).body.job;
  }
  expect(job).toMatchObject({ state: "done", path: "sub/Fetched.pdf", received: PDF.length });
  expect(readFileSync(join(lib, "sub/Fetched.pdf"), "utf-8")).toBe(PDF);
  expect((await call(lan, `/api/library`)).body.books.some((b: { id: string }) => b.id === job.bookId)).toBe(true);
  expect((await call(lan, "/api/admin/import", { body: { link: wrapped, folder: "sub", name: "Fetched" }, cookie: adminCookie })).body).toEqual({ error: "exists" });
  expect((await call(lan, `/api/admin/import/${jobId}`, { method: "DELETE", cookie: adminCookie })).status).toBe(404); // nothing running to cancel
  expect((await call(lan, "/api/admin/import/nope", { cookie: adminCookie })).status).toBe(404);
});

test("choosing the library folder: only the administrator lists folders, and only from this computer can the program be stopped", async () => {
  const listing = (path?: string, cookie = adminCookie) => call(lan, `/api/admin/fs/browse${path === undefined ? "" : "?path=" + encodeURIComponent(path)}`, { cookie });
  expect((await listing(lib, "")).status).toBe(401);
  expect((await listing(lib, (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!)).status).toBe(403);
  const here = (await listing(lib)).body;
  expect(here).toMatchObject({ path: lib, dirs: ["sub"] });
  expect(here.books).toBeGreaterThan(0);
  expect((await listing()).body.home).toBeString();
  expect((await listing("relative")).body).toEqual({ error: "not a folder" });

  expect((await call(lan, "/api/me", { cookie: adminCookie })).body.canStop).toBe(true);
  expect((await call(tunnelSide, "/api/me")).body.canStop).toBe(false);
  expect((await call(lan, "/api/admin/stop", { body: {} })).status).toBe(401);
  expect((await call(tunnelSide, "/api/admin/stop", { body: {}, cookie: adminCookie })).status).toBe(403); // even the administrator, from the internet side
  expect(stops).toEqual([]);
  expect((await call(lan, "/api/admin/stop", { body: {}, cookie: adminCookie })).status).toBe(200);
  await Bun.sleep(400);
  expect(stops).toEqual([1]);
});

test("bookmarks belong to the signed-in reader and nobody else", async () => {
  const mine = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  const view = { v: 1, page: 4, zoom: 1.5 };
  expect((await call(lan, "/api/bookmarks")).status).toBe(401); // anonymous readers have none
  expect((await call(lan, "/api/bookmarks", { body: { bookId, label: "x", view } })).status).toBe(401);

  const made = await call(lan, "/api/bookmarks", { body: { bookId, label: "  Where the river bends  ", view }, cookie: mine });
  expect(made.status).toBe(200);
  expect(made.body.bookmark).toMatchObject({ bookId, label: "Where the river bends", view });
  expect((await call(lan, "/api/bookmarks", { body: { bookId, label: "   ", view }, cookie: mine })).status).toBe(400);
  expect((await call(lan, "/api/bookmarks", { body: { bookId: "nope", label: "x", view }, cookie: mine })).status).toBe(400);
  expect((await call(lan, "/api/bookmarks", { body: { bookId, label: "x", view: "page 4" }, cookie: mine })).status).toBe(400);
  expect((await call(lan, "/api/bookmarks", { body: { bookId, label: "x", view: { blob: "x".repeat(5000) } }, cookie: mine })).status).toBe(400);

  const list = (await call(lan, `/api/bookmarks?book=${bookId}`, { cookie: mine })).body.bookmarks;
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ label: "Where the river bends", book: { name: "one", ext: "txt" } });
  expect((await call(lan, "/api/bookmarks?book=other", { cookie: mine })).body.bookmarks).toEqual([]);

  // another reader sees none of it and cannot remove or rename it
  expect((await call(lan, "/api/bookmarks", { cookie: adminCookie })).body.bookmarks).toEqual([]);
  const id = made.body.bookmark.id;
  expect((await call(lan, `/api/bookmarks/${id}`, { method: "DELETE", cookie: adminCookie })).status).toBe(404);
  expect((await call(lan, `/api/bookmarks/${id}`, { body: { label: "mine now" }, cookie: adminCookie })).status).toBe(404);
  expect((await call(lan, `/api/bookmarks/${id}`, { body: { label: "Renamed" }, cookie: mine })).status).toBe(200);
  expect((await call(lan, "/api/bookmarks", { cookie: mine })).body.bookmarks[0].label).toBe("Renamed");
  expect((await call(lan, `/api/bookmarks/${id}`, { method: "DELETE", cookie: mine })).status).toBe(200);
  expect((await call(lan, "/api/bookmarks", { cookie: mine })).body.bookmarks).toEqual([]);
});

test("projects belong to the signed-in reader, hold places in library books and notes, and keep what a missing book leaves", async () => {
  const mine = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  const post = (path: string, body: unknown, cookie: string | null = mine, method = "POST") => call(lan, `/api/projects${path}`, { method, body, cookie: cookie ?? undefined }); // null: not signed in
  expect((await call(lan, "/api/projects")).status).toBe(401); // anonymous readers have none
  expect((await post("", { title: "x" }, null)).status).toBe(401);

  const made = await post("", { title: "  My amplifier  ", description: "two stages" });
  expect(made.status).toBe(200);
  expect(made.body.project).toMatchObject({ title: "My amplifier", description: "two stages", items: 0 });
  const id = made.body.project.id;
  expect((await post("", { title: "  " })).status).toBe(400);
  expect((await post("", "title")).status).toBe(400);

  const view = { v: 1, page: 4, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
  const item = await post(`/${id}/items`, { bookId, view, title: "Schematic", comment: "second stage" });
  expect(item.status).toBe(200);
  expect(item.body.item).toMatchObject({ bookId, view, title: "Schematic", comment: "second stage", book: { name: "one", ext: "txt" }, missing: false });
  const note = await post(`/${id}/items`, { title: "Check the values", comment: "own note" });
  expect(note.body.item).toMatchObject({ bookId: null, book: null, missing: false });
  expect((await post(`/${id}/items`, { bookId: "nope", view, title: "x" })).status).toBe(400); // only books of this library
  expect((await post(`/${id}/items`, { bookId, view: "page 4", title: "x" })).status).toBe(400);
  expect((await post(`/${id}/items`, { bookId, view, title: " " })).status).toBe(400);
  expect((await post("/999999/items", { title: "x" })).status).toBe(404);

  const opened = (await call(lan, `/api/projects/${id}`, { cookie: mine })).body;
  expect(opened.project).toMatchObject({ title: "My amplifier", items: 2 });
  expect(opened.items.map((i: { title: string }) => i.title)).toEqual(["Schematic", "Check the values"]);
  expect((await call(lan, "/api/projects", { cookie: mine })).body.projects).toHaveLength(1);

  // another reader sees none of it and cannot change it
  const itemId = item.body.item.id;
  expect((await call(lan, "/api/projects", { cookie: adminCookie })).body.projects).toEqual([]);
  expect((await call(lan, `/api/projects/${id}`, { cookie: adminCookie })).status).toBe(404);
  expect((await post(`/${id}`, { title: "taken" }, adminCookie)).status).toBe(404);
  expect((await post(`/${id}/items`, { title: "intruder" }, adminCookie)).status).toBe(404);
  expect((await post(`/${id}/items/${itemId}`, { title: "taken" }, adminCookie)).status).toBe(404);
  expect((await post(`/${id}/items/${itemId}`, undefined, adminCookie, "DELETE")).status).toBe(404);
  expect((await post(`/${id}/order`, { items: [itemId, note.body.item.id] }, adminCookie)).status).toBe(404);
  expect((await post(`/${id}`, undefined, adminCookie, "DELETE")).status).toBe(404);

  // editing, ordering
  expect((await post(`/${id}`, { title: "Amplifier v2" })).status).toBe(200);
  expect((await post(`/${id}/items/${itemId}`, { comment: "third stage" })).status).toBe(200);
  expect((await post(`/${id}/items/${itemId}`, { title: "" })).status).toBe(400);
  expect((await post(`/${id}/items/999999`, { title: "x" })).status).toBe(404);
  expect((await post(`/${id}/order`, { items: [note.body.item.id, itemId] })).status).toBe(200);
  expect((await post(`/${id}/order`, { items: [itemId] })).status).toBe(400); // must name every item
  expect((await post(`/${id}/order`, { items: "last" })).status).toBe(400);
  const again = (await call(lan, `/api/projects/${id}`, { cookie: mine })).body;
  expect(again.project.title).toBe("Amplifier v2");
  expect(again.items.map((i: { title: string; comment: string }) => [i.title, i.comment])).toEqual([["Check the values", "own note"], ["Schematic", "third stage"]]);

  // a book that left the library is marked; the item keeps its notes and source
  const owner = (db.query("SELECT user_id AS id FROM projects WHERE id = ?").get(id) as { id: number }).id;
  new Projects(db).addItem(owner, id, { bookId: "ffffffffffffffffffff", view: { v: 1, page: 2 }, title: "From a lost book", quote: "words" });
  const lost = (await call(lan, `/api/projects/${id}`, { cookie: mine })).body.items.at(-1);
  expect(lost).toMatchObject({ title: "From a lost book", quote: "words", bookId: "ffffffffffffffffffff", view: { v: 1, page: 2 }, book: null, missing: true });

  expect((await post(`/${id}/items/${itemId}`, undefined, mine, "DELETE")).status).toBe(200);
  expect((await call(lan, `/api/projects/${id}`, { cookie: mine })).body.items).toHaveLength(2);
  expect((await post(`/${id}`, undefined, mine, "DELETE")).status).toBe(200);
  expect((await call(lan, `/api/projects/${id}`, { cookie: mine })).status).toBe(404);
  expect((await call(lan, "/api/projects", { cookie: mine })).body.projects).toEqual([]);
});

test("reading places belong to the signed-in reader and nobody else", async () => {
  const mine = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  const put = (cookie: string | undefined, body: unknown, id = bookId) => call(lan, `/api/progress/${id}`, { method: "PUT", body, cookie });
  const view = { v: 1, offset: 120 };
  expect((await call(lan, "/api/progress")).status).toBe(401); // anonymous readers keep theirs in the browser
  expect((await put(undefined, { view })).status).toBe(401);

  expect((await put(mine, { view, label: "  Page 3 " })).status).toBe(200);
  expect((await put(mine, { view: "page 4" })).status).toBe(400);
  expect((await put(mine, { view: { blob: "x".repeat(5000) } })).status).toBe(400);
  expect((await put(mine, { view }, "nope")).status).toBe(400); // only books of this library
  expect((await call(lan, `/api/progress/${bookId}`, { cookie: mine })).body.progress).toMatchObject({ bookId, view, label: "Page 3" });

  // opening the book again without a place keeps the place
  expect((await put(mine, {})).status).toBe(200);
  expect((await call(lan, "/api/progress", { cookie: mine })).body.progress).toMatchObject([{ bookId, view, label: "Page 3" }]);

  // another reader sees none of it
  expect((await call(lan, "/api/progress", { cookie: adminCookie })).body.progress).toEqual([]);
  expect((await call(lan, `/api/progress/${bookId}`, { cookie: adminCookie })).body.progress).toBeNull();
  expect((await call(lan, `/api/progress/${bookId}`, { method: "DELETE", cookie: adminCookie })).status).toBe(404);
  expect((await call(lan, `/api/progress/${bookId}`, { method: "DELETE", cookie: mine })).status).toBe(200);
  expect((await call(lan, "/api/progress", { cookie: mine })).body.progress).toEqual([]);
});

test("display settings belong to the signed-in reader, are checked, and a default look is not kept", async () => {
  const mine = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  const put = (cookie: string | undefined, body: unknown, id = bookId) => call(lan, `/api/display/${id}`, { method: "PUT", body, cookie });
  const get = (cookie: string | undefined) => call(lan, `/api/display/${bookId}`, { cookie });
  expect((await get(undefined)).status).toBe(401); // guests keep theirs in the browser
  expect((await put(undefined, { display: { rotation: 90 } })).status).toBe(401);

  expect((await put(mine, { display: { rotation: 90 } })).status).toBe(200);
  expect((await get(mine)).body.display).toEqual({ rotation: 90 });
  expect((await put(mine, { display: { rotation: 45 } })).status).toBe(400);
  expect((await put(mine, { display: "turn" })).status).toBe(400);
  expect((await put(mine, {})).status).toBe(400);
  expect((await put(mine, { display: { rotation: 90 } }, "nope")).status).toBe(400); // only books of this library
  expect((await get(mine)).body.display).toEqual({ rotation: 90 }); // the bad ones changed nothing

  expect((await get(adminCookie)).body.display).toBeNull(); // another reader sees none of it
  expect((await put(mine, { display: { rotation: 0 } })).status).toBe(200); // back to the file's own look: nothing to keep
  expect((await get(mine)).body.display).toBeNull();
});

test("deleting an account deletes its bookmarks", async () => {
  const users = (await call(lan, "/api/admin/settings", { cookie: adminCookie })).body.users as { id: number; name: string }[];
  const reader = users.find((u) => u.name === "Reader")!;
  const mine = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  await call(lan, "/api/bookmarks", { body: { bookId, label: "keep me", view: { v: 1 } }, cookie: mine });
  expect((db.query("SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?").get(reader.id) as { n: number }).n).toBe(1);
  expect((await call(lan, `/api/admin/users/${reader.id}`, { method: "DELETE", cookie: adminCookie })).status).toBe(200);
  expect((db.query("SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?").get(reader.id) as { n: number }).n).toBe(0);
});

test("editing the library is for the administrator, changes real files, and refuses unsafe requests", async () => {
  const admin = adminCookie;
  const asUser = (await call(lan, "/api/register", { body: { name: "Plain", password: "pin1234" } })).cookie!;
  const move = (cookie: string | undefined, body: object) => call(lan, "/api/admin/fs/move", { body, cookie });
  expect((await move(undefined, { kind: "book", path: "one.txt", to: "sub" })).status).toBe(401);
  expect((await move(asUser, { kind: "book", path: "one.txt", to: "sub" })).status).toBe(403);
  expect((await call(lan, "/api/admin/fs/mkdir", { body: { parent: "", name: "x" }, cookie: asUser })).status).toBe(403);
  expect((await call(lan, "/api/status")).body.writable).toBe(true);

  expect((await call(lan, "/api/admin/fs/mkdir", { body: { parent: "", name: "Shelf" }, cookie: admin })).status).toBe(200);
  expect((await call(lan, "/api/admin/fs/mkdir", { body: { parent: "", name: "Shelf" }, cookie: admin })).body.error).toBe("exists");
  expect((await call(lan, "/api/admin/fs/mkdir", { body: { parent: "", name: "../escape" }, cookie: admin })).body.error).toBe("invalid-name");
  expect((await move(admin, { kind: "book", path: "../../etc/passwd", to: "Shelf" })).body.error).toBe("missing");
  expect((await move(admin, { kind: "folder", path: "sub", to: "sub" })).body.error).toBe("into-itself");

  expect((await move(admin, { kind: "book", path: "one.txt", to: "Shelf" })).status).toBe(200);
  expect(Bun.file(join(lib, "Shelf/one.txt")).size).toBeGreaterThan(0);
  const moved = (await call(lan, "/api/library")).body.books.find((b: { name: string }) => b.name === "one");
  expect(moved).toMatchObject({ path: "Shelf/one.txt", id: bookId }); // same content id: links and bookmarks still point here
  expect((await call(lan, "/api/admin/fs/rename", { body: { kind: "book", path: "Shelf/one.txt", name: "First" }, cookie: admin })).status).toBe(200);
  expect((await call(lan, `/api/file/${bookId}`)).body).toBe("first book, 0123456789");
});

test("the backup is for the administrator; restoring it brings back accounts and settings and keeps the administrator signed in", async () => {
  const admin = adminCookie;
  const reader = (await call(lan, "/api/register", { body: { name: "Backup Reader", password: "pin1234" } })).cookie!;
  await call(lan, "/api/bookmarks", { body: { bookId, label: "before", view: { v: 1, page: 4 } }, cookie: reader });
  expect((await call(lan, "/api/admin/backup")).status).toBe(401);
  expect((await call(lan, "/api/admin/backup", { cookie: reader })).status).toBe(403);
  expect((await call(lan, "/api/admin/restore", { body: {}, cookie: reader })).status).toBe(403);

  const saved = await fetch(lan + "/api/admin/backup", { headers: { Cookie: admin } });
  expect(saved.headers.get("content-disposition")).toMatch(/^attachment; filename="tapalog-reader-backup-\d{4}-\d{2}-\d{2}\.json"$/);
  const file = (await saved.json()) as { users: { name: string }[]; bookmarks: unknown[]; settings: object };
  expect(file.users.map((u) => u.name)).toContain("Backup Reader");

  // changes made after the backup...
  await call(lan, "/api/admin/settings", { body: { lanAccess: "login", allowRegistration: false }, cookie: admin });
  const users = (await call(lan, "/api/admin/settings", { cookie: admin })).body.users as { id: number; name: string }[];
  await call(lan, `/api/admin/users/${users.find((u) => u.name === "Backup Reader")!.id}`, { method: "DELETE", cookie: admin });
  expect((await call(lan, "/api/bookmarks", { cookie: reader })).status).toBe(401);

  // a damaged file changes nothing
  expect((await call(lan, "/api/admin/restore", { body: { ...file, version: 99 }, cookie: admin })).body.error).toBe("version");
  expect((await call(lan, "/api/admin/restore", { body: { ...file, users: [] }, cookie: admin })).body.error).toBe("no-admin");
  expect((await call(lan, "/api/me", { cookie: admin })).body.user).toMatchObject({ name: "Alex" });

  // ...are undone by restoring it
  const restored = await call(lan, "/api/admin/restore", { body: file, cookie: admin });
  expect(restored.status).toBe(200);
  expect(restored.body).toMatchObject({ ok: true, signedIn: true });
  expect(restored.cookie).toStartWith("sid=");
  adminCookie = restored.cookie!;
  expect((await call(lan, "/api/me", { cookie: admin })).body.user).toBeNull(); // old sessions are gone
  expect((await call(lan, "/api/admin/settings", { cookie: adminCookie })).body).toMatchObject({ lanAccess: "open", allowRegistration: true });
  const again = (await call(lan, "/api/login", { body: { name: "Backup Reader", password: "pin1234" } })).cookie!;
  expect((await call(lan, "/api/bookmarks", { cookie: again })).body.bookmarks.map((b: { label: string }) => b.label)).toEqual(["before"]);

  // first-run restore is only for a computer that has no accounts yet
  expect((await call(lan, "/api/setup/restore", { body: file })).status).toBe(403);
});

test("duplicates are found and extra copies are put in the trash by the administrator only, never the last copy", async () => {
  const same = "%PDF-1.4 the very same book, twice";
  writeFileSync(join(lib, "Twice.pdf"), same);
  writeFileSync(join(lib, "sub/Twice (copy).pdf"), same);
  writeFileSync(join(lib, "sub/Radio Guide.epub"), "PK one");
  writeFileSync(join(lib, "Radio guide.pdf"), "%PDF-1.4 another");
  await library.rescan();
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Reader", password: "newpin9" } })).cookie!;
  for (const cookie of ["", readerCookie]) {
    expect((await call(lan, "/api/admin/duplicates", { body: {}, cookie })).status).toBe(cookie ? 403 : 401);
    expect((await call(lan, "/api/admin/duplicates/trash", { body: { paths: ["Twice.pdf"] }, cookie })).status).toBe(cookie ? 403 : 401);
  }
  expect((await call(lan, "/api/admin/duplicates", { cookie: adminCookie })).status).toBe(404); // a plain GET is nothing

  const found = (await call(lan, "/api/admin/duplicates", { body: {}, cookie: adminCookie })).body;
  expect(found.exact.map((g: any) => g.items.map((i: any) => i.path).sort())).toEqual([["Twice.pdf", "sub/Twice (copy).pdf"]]);
  expect(found.similar.map((g: any) => g.items.map((i: any) => i.path).sort())).toEqual([["Radio guide.pdf", "sub/Radio Guide.epub"]]);

  const trash = (paths: unknown) => call(lan, "/api/admin/duplicates/trash", { body: { paths }, cookie: adminCookie });
  expect((await trash(["Twice.pdf", "sub/Twice (copy).pdf"])).body).toEqual({ error: "last-copy" });
  expect((await trash("Twice.pdf")).status).toBe(400);
  expect((await trash([1, 2])).status).toBe(400);
  expect((await trash(["nothing.pdf"])).body).toEqual({ error: "missing" });
  expect(existsSync(join(lib, "Twice.pdf"))).toBe(true);

  expect((await trash(["sub/Twice (copy).pdf"])).body).toEqual({ trashed: 1 });
  expect(existsSync(join(lib, "sub/Twice (copy).pdf"))).toBe(false);
  expect(existsSync(join(lib, ".tapalog-trash"))).toBe(true);
  const books = (await call(lan, "/api/library", { cookie: adminCookie })).body.books as { path: string }[];
  expect(books.some((b) => b.path === "sub/Twice (copy).pdf")).toBe(false);
  expect(books.some((b) => b.path === "Twice.pdf")).toBe(true);
  expect((await call(lan, "/api/admin/duplicates", { body: {}, cookie: adminCookie })).body.exact).toEqual([]);
});

test("saved source sites are the administrator's to manage", async () => {
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Backup Reader", password: "pin1234" } })).cookie!; // the account the restore above brought back
  expect(readerCookie).toStartWith("sid=");
  for (const cookie of ["", readerCookie]) {
    const want = cookie ? 403 : 401;
    expect((await call(lan, "/api/admin/sources", { cookie })).status).toBe(want);
    expect((await call(lan, "/api/admin/sources", { body: { name: "x", url: "https://example.org/" }, cookie })).status).toBe(want);
    expect((await call(lan, "/api/admin/sources/1", { method: "DELETE", cookie })).status).toBe(want);
  }
  const add = (name: unknown, url: unknown) => call(lan, "/api/admin/sources", { body: { name, url }, cookie: adminCookie });
  const added = (await add("Facebook channel", "https://www.facebook.com/1shirshov/")).body.source;
  expect(added).toMatchObject({ name: "Facebook channel", url: "https://www.facebook.com/1shirshov/" });
  expect((await add("Again", "https://www.facebook.com/1shirshov/")).body).toEqual({ error: "exists" });
  expect((await add("Bad", "javascript:alert(1)")).body).toEqual({ error: "bad-link" });
  expect((await add("", "https://example.org/")).body).toEqual({ error: "invalid-name" });
  expect((await call(lan, "/api/admin/sources", { cookie: adminCookie })).body).toEqual({ sources: [added] });
  expect((await call(lan, `/api/admin/sources/${added.id}`, { method: "DELETE", cookie: adminCookie })).status).toBe(200);
  expect((await call(lan, `/api/admin/sources/${added.id}`, { method: "DELETE", cookie: adminCookie })).status).toBe(404);
  expect((await call(lan, "/api/admin/sources", { cookie: adminCookie })).body).toEqual({ sources: [] });
});

test("installed plugins are listed and their files served (also to a share link's page), and only their own files", async () => {
  const list = (await call(lan, "/api/plugins", { cookie: adminCookie })).body;
  expect(list).toEqual({
    api: 2,
    plugins: [
      { id: "demo", name: "Demo reader", version: "1.2.3", api: 1, exts: ["demo", "dmo"], reader: "/plugins/demo/reader.js", shareableView: true, cover: false, isolated: false },
      { id: "sealed", name: "Sealed reader", version: "", api: 2, exts: ["seal"], reader: "/plugins/sealed/reader.js", shareableView: false, cover: false, isolated: true },
    ],
  });

  expect((await call(lan, "/api/plugins", { cookie: "" })).body.plugins).toHaveLength(2); // no login needed: the page of a share link reads it too
  const reader = await fetch(lan + "/plugins/demo/reader.js");
  expect(reader.status).toBe(200);
  expect(reader.headers.get("content-type")).toBe("text/javascript");
  expect(reader.headers.get("x-content-type-options")).toBe("nosniff");
  expect(reader.headers.get("access-control-allow-origin")).toBeNull(); // read by the page itself
  expect(await reader.text()).toContain("export function mount");
  // an isolated plugin's frame is a stranger to the program: its files can be read across origins
  expect((await fetch(lan + "/plugins/sealed/reader.js")).headers.get("access-control-allow-origin")).toBe("*");
  expect(await (await fetch(lan + "/plugins/demo/assets/data.txt", { headers: { Cookie: adminCookie } })).text()).toBe("plugin data");

  for (const path of ["/plugins/demo/../secret.txt", "/plugins/demo/%2e%2e/secret.txt", "/plugins/demo/..%2fsecret.txt", "/plugins/demo/assets", "/plugins/demo/", "/plugins/demo", "/plugins/nope/reader.js", "/plugins/broken/plugin.json", "/plugins/demo/%00", "/plugins/demo/%E0%A4%A"]) {
    const res = await fetch(lan + path, { headers: { Cookie: adminCookie } });
    expect([path, res.status]).toEqual([path, 404]);
  }

  const readerCookie = (await call(lan, "/api/login", { body: { name: "Backup Reader", password: "pin1234" } })).cookie!; // the account the restore above brought back
  expect((await call(lan, "/api/admin/plugins", { cookie: readerCookie })).status).toBe(403);
  const admin = (await call(lan, "/api/admin/plugins", { cookie: adminCookie })).body;
  expect(admin.dir).toBe(pluginsDir);
  expect(admin.problems).toEqual([{ folder: "broken", problem: "plugin.json is not valid JSON" }]);
});

test("an isolated plugin gets a page of its own that is a sandbox, the script that connects it to the reader, and nothing else under /plugin-host/", async () => {
  const page = await fetch(lan + "/plugin-host/sealed");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toStartWith("text/html");
  const csp = page.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("sandbox allow-scripts"); // the same sandbox even when the address is opened by hand
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).toContain("default-src 'none'");
  expect(await page.text()).toContain('src="/plugin-host/bridge.js"');

  const bridge = await fetch(lan + "/plugin-host/bridge.js");
  expect(bridge.status).toBe(200);
  expect(bridge.headers.get("content-type")).toBe("text/javascript");
  expect(bridge.headers.get("access-control-allow-origin")).toBe("*"); // read by a frame whose origin is opaque
  expect(await bridge.text()).toContain("need-file");

  // a plugin that is not isolated, one that does not exist, and odd names have no such page
  for (const path of ["/plugin-host/demo", "/plugin-host/nope", "/plugin-host/", "/plugin-host", "/plugin-host/%E0%A4%A", "/plugin-host/sealed/x", "/plugin-host/..%2fsealed"]) {
    const res = await fetch(lan + path);
    expect([path, res.status]).toEqual([path, 404]);
  }
});

test("a book's card is read by anyone who can browse and changed by the administrator only; the shelf, the search and the tag list follow", async () => {
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Backup Reader", password: "pin1234" } })).cookie!;
  const one = (await call(lan, "/api/library", { cookie: adminCookie })).body.books.find((b: { id: string }) => b.id === bookId) as { id: string; name: string; path: string; title: string }; // an earlier test moved and renamed this file
  expect(one.title).toBe(one.name); // no card yet: the file's name

  const put = (cookie: string, body: unknown, id = one.id, headers?: Record<string, string>) => call(lan, `/api/admin/books/${id}/meta`, { method: "PUT", body, cookie, headers });
  expect((await put("", { set: { title: "x" } })).status).toBe(401);
  expect((await put(readerCookie, { set: { title: "x" } })).status).toBe(403);
  expect((await put(adminCookie, { set: { title: "x" } }, "0".repeat(20))).status).toBe(404);
  expect((await put(adminCookie, { set: { title: "x" } }, one.id, { Origin: "https://evil.example" })).status).toBe(400);
  expect((await put(adminCookie, { set: { year: "1949" } })).body).toEqual({ error: "year" });
  expect((await put(adminCookie, { set: { colour: "red" } })).body).toEqual({ error: "unknown field" });
  expect((await call(lan, `/api/books/${one.id}/meta`, { cookie: adminCookie })).body.edited).toEqual([]); // nothing refused was stored

  const card = (await put(adminCookie, { set: { title: "  First book ", authors: ["A. Author"], year: 1949, tags: ["Радио", "радио", "схемы"], description: "About it.\n\nMore." } })).body;
  expect(card).toMatchObject({ id: one.id, name: one.name, path: one.path, ext: "txt", copies: [one.path], edited: ["title", "authors", "year", "tags", "description"] });
  expect(card.fields).toEqual({ title: "First book", authors: ["A. Author"], year: 1949, series: "", description: "About it.\n\nMore.", language: "", tags: ["Радио", "схемы"] });

  expect((await call(lan, `/api/books/${one.id}/meta`, { cookie: readerCookie })).body.fields.title).toBe("First book"); // readers see it
  const shelf = (await call(lan, "/api/library", { cookie: readerCookie })).body.books.find((b: { id: string }) => b.id === one.id);
  expect(shelf).toMatchObject({ name: one.name, title: "First book", authors: ["A. Author"], year: 1949, series: "", tags: ["Радио", "схемы"] });
  expect((await call(lan, "/api/search?q=author", { cookie: readerCookie })).body.books.map((b: { name: string }) => b.name)).toEqual([one.name]); // found by the author, not the file's name
  expect((await call(lan, "/api/search?q=%D0%A0%D0%90%D0%94%D0%98%D0%9E", { cookie: readerCookie })).body.books.map((b: { name: string }) => b.name)).toEqual([one.name]); // a tag, in capitals
  expect((await call(lan, "/api/tags", { cookie: readerCookie })).body).toEqual({ tags: [{ tag: "Радио", books: 1 }, { tag: "схемы", books: 1 }] });
  expect((await call(lan, "/api/admin/backup", { cookie: adminCookie })).body.bookMeta).toEqual([{ bookId: one.id, manual: expect.objectContaining({ title: "First book" }) }]);

  const reset = (await put(adminCookie, { reset: ["title", "authors", "year", "tags", "description"] })).body;
  expect(reset.edited).toEqual([]);
  expect((await call(lan, "/api/library", { cookie: readerCookie })).body.books.find((b: { id: string }) => b.id === one.id).title).toBe(one.name);
});

test("bookmarks, project items and share links show a book by its title, and the file's name when it has none", async () => {
  const name = (await call(lan, "/api/library", { cookie: adminCookie })).body.books.find((b: { id: string }) => b.id === bookId).name as string; // earlier tests renamed the file
  const meta = (body: unknown) => call(lan, `/api/admin/books/${bookId}/meta`, { method: "PUT", body, cookie: adminCookie });
  expect((await meta({ set: { title: "A title from the card" } })).status).toBe(200);

  const bookmark = (await call(lan, "/api/bookmarks", { body: { bookId, label: "here", view: { v: 1, page: 1 } }, cookie: adminCookie })).body.bookmark;
  expect((await call(lan, "/api/bookmarks", { cookie: adminCookie })).body.bookmarks[0].book).toMatchObject({ name, title: "A title from the card" });

  const project = (await call(lan, "/api/projects", { body: { title: "P" }, cookie: adminCookie })).body.project;
  const item = (await call(lan, `/api/projects/${project.id}/items`, { body: { bookId, title: "item", view: { v: 1, page: 1 } }, cookie: adminCookie })).body.item;
  expect(item.book).toMatchObject({ name, title: "A title from the card" });
  expect((await call(lan, `/api/projects/${project.id}`, { cookie: adminCookie })).body.items[0].book.title).toBe("A title from the card");

  const token = (await call(lan, "/api/shares", { body: { bookId }, cookie: adminCookie })).body.token;
  expect((await call(lan, "/api/shares", { cookie: adminCookie })).body.shares.find((s: { token: string }) => s.token === token)).toMatchObject({ name, title: "A title from the card" });
  expect((await call(tunnelSide, `/api/share/${token}`)).body).toMatchObject({ name, title: "A title from the card" }); // what a visitor with the link sees

  expect((await meta({ reset: ["title"] })).status).toBe(200);
  expect((await call(lan, `/api/projects/${project.id}`, { cookie: adminCookie })).body.items[0].book.title).toBe(name); // no title typed: the file's name
  await call(lan, `/api/bookmarks/${bookmark.id}`, { method: "DELETE", cookie: adminCookie });
  await call(lan, `/api/projects/${project.id}`, { method: "DELETE", cookie: adminCookie });
  await call(lan, `/api/shares/${token}`, { method: "DELETE", cookie: adminCookie });
});

test("tags are renamed and taken away for the whole library by the administrator only", async () => {
  // a reader of its own: earlier tests changed or restored the accounts that were there
  expect((await call(lan, "/api/admin/users", { body: { name: "Tagger", password: "tag123", role: "user" }, cookie: adminCookie })).status).toBe(200);
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Tagger", password: "tag123" } })).cookie!;
  const meta = (body: unknown) => call(lan, `/api/admin/books/${bookId}/meta`, { method: "PUT", body, cookie: adminCookie });
  const tagList = async () => (await call(lan, "/api/tags", { cookie: adminCookie })).body.tags.map((t: { tag: string }) => t.tag);
  await meta({ set: { tags: ["Old tag", "keep"] } });

  expect((await call(lan, "/api/admin/tags/rename", { body: { from: "old tag", to: "new" }, cookie: "" })).status).toBe(401);
  expect((await call(lan, "/api/admin/tags/rename", { body: { from: "old tag", to: "new" }, cookie: readerCookie })).status).toBe(403);
  expect((await call(lan, "/api/admin/tags/remove", { body: { tag: "keep" }, cookie: readerCookie })).status).toBe(403);
  expect(await tagList()).toEqual(expect.arrayContaining(["Old tag", "keep"])); // nothing was changed

  expect((await call(lan, "/api/admin/tags/rename", { body: { from: "OLD TAG", to: "New tag" }, cookie: adminCookie })).body).toEqual({ changed: 1 });
  expect(await tagList()).toEqual(expect.arrayContaining(["New tag", "keep"]));
  expect((await call(lan, "/api/admin/tags/rename", { body: { from: "new tag", to: "   " }, cookie: adminCookie })).status).toBe(400);
  expect((await call(lan, "/api/admin/tags/rename", { body: { from: 5, to: "x" }, cookie: adminCookie })).status).toBe(400);
  expect((await call(lan, "/api/admin/tags/remove", { body: { tag: "New tag" }, cookie: adminCookie })).body).toEqual({ changed: 1 });
  expect((await call(lan, "/api/admin/tags/remove", { body: { tag: "keep" }, cookie: adminCookie })).body).toEqual({ changed: 1 });
  expect(await tagList()).toEqual([]);
  await meta({ reset: ["tags"] });
});

test("the About information names the version and the parts, and only the administrator is told where the program keeps its files", async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string };
  expect((await call(lan, "/api/about")).body.dataFolder).toBeNull(); // nobody signed in (the network is open to browsing here): no folder
  const asAdmin = (await call(lan, "/api/about", { cookie: adminCookie })).body;
  expect(asAdmin).toMatchObject({ name: "Tapalog Reader", version: pkg.version, license: "MIT" });
  expect(asAdmin.components.map((c: { name: string }) => c.name)).toContain("pdf.js");
  expect(asAdmin.components.every((c: { license: string; url: string }) => c.license && c.url.startsWith("https://"))).toBe(true);
  expect(typeof asAdmin.dataFolder).toBe("string");
  expect((await call(lan, "/api/admin/users", { body: { name: "Abouter", password: "about1", role: "user" }, cookie: adminCookie })).status).toBe(200);
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Abouter", password: "about1" } })).cookie!;
  const asReader = (await call(lan, "/api/about", { cookie: readerCookie })).body;
  expect(asReader.version).toBe(pkg.version);
  expect(asReader.dataFolder).toBeNull();
});

test("the administrator's browser reads a scan page by page and the server keeps the text, where search finds it", async () => {
  const books = (await call(lan, "/api/library", { cookie: adminCookie })).body.books as { id: string; path: string }[];
  const pdf = books.find((b) => b.path === "sub/three.pdf")!.id; // not a real PDF: the browser would draw it, the server never opens it
  const txt = books.find((b) => b.path.endsWith(".txt"))!.id; // earlier tests renamed "one": any text file will do
  expect((await call(lan, "/api/admin/users", { body: { name: "Scanner", password: "scan123", role: "user" }, cookie: adminCookie })).status).toBe(200);
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Scanner", password: "scan123" } })).cookie!;
  const start = (id: string, body: unknown, cookie = adminCookie) => call(lan, `/api/admin/ocr/${id}/start`, { body, cookie });
  const put = (id: string, page: number | string, text: unknown, cookie = adminCookie) => call(lan, `/api/admin/ocr/${id}/pages/${page}`, { method: "PUT", body: { text }, cookie });

  // only the administrator, and only a PDF with a sensible page count and a language the engine has
  expect((await call(lan, "/api/admin/ocr")).status).toBe(401);
  expect((await call(lan, "/api/admin/ocr", { cookie: readerCookie })).status).toBe(403);
  expect((await start(pdf, { pages: 2, lang: "rus" }, readerCookie)).status).toBe(403);
  expect((await start(pdf, { pages: 0, lang: "rus" })).status).toBe(400);
  expect((await start(pdf, { pages: 2.5, lang: "rus" })).status).toBe(400);
  expect((await start(pdf, { pages: 2, lang: "deu" })).status).toBe(400);
  expect((await start(txt, { pages: 2, lang: "rus" })).status).toBe(400); // a text file has nothing to read
  expect((await start("nope", { pages: 2, lang: "rus" })).status).toBe(404);

  expect((await start(pdf, { pages: 2, lang: "rus" })).body).toEqual({ done: [] });
  expect((await put(pdf, 1, "Старый ламповый осциллограф с экраном")).body).toEqual({ done: 1, pages: 2 });
  expect((await put(pdf, 3, "beyond")).status).toBe(404);
  expect((await put(pdf, "x", "beyond")).status).toBe(404);
  expect((await put(pdf, 1, 5)).status).toBe(400);
  expect((await put(pdf, 2, "text", readerCookie)).status).toBe(403);

  const list = (await call(lan, "/api/admin/ocr", { cookie: adminCookie })).body;
  expect(list.books.find((b: { id: string }) => b.id === pdf)).toMatchObject({ pages: 2, done: 1, lang: "rus", path: "sub/three.pdf" });
  expect(list.books.every((b: { size: unknown }) => typeof b.size === "number")).toBe(true);
  expect(list).toMatchObject({ recognizedBooks: 1, recognizedPages: 1 });

  await call(lan, "/api/admin/fulltext", { body: { enabled: true }, cookie: adminCookie }); // an earlier test may have turned the search off
  const found = (await call(lan, "/api/fulltext?q=осциллограф")).body.books;
  expect(found).toHaveLength(1);
  expect(found[0].hits[0]).toMatchObject({ loc: { page: 1 }, view: { v: 1, page: 1 } });

  expect((await start(pdf, { pages: 2, lang: "rus+eng" })).body).toEqual({ done: [1] }); // going on after a stop
  expect((await call(lan, `/api/admin/ocr/${pdf}`, { method: "DELETE", cookie: readerCookie })).status).toBe(403);
  expect((await call(lan, `/api/admin/ocr/${pdf}`, { method: "DELETE", cookie: adminCookie })).body).toEqual({ removed: 1 });
  expect((await call(lan, "/api/fulltext?q=осциллограф")).body.books).toEqual([]);
  await call(lan, "/api/admin/fulltext", { body: { enabled: false }, cookie: adminCookie }); // as it was: nothing left running when the library closes
});

test("the frames of the words of a scanned page come with its text, and whoever may read the book gets them to make the scan selectable", async () => {
  const books = (await call(lan, "/api/library", { cookie: adminCookie })).body.books as { id: string; path: string }[];
  const pdf = books.find((b) => b.path === "sub/three.pdf")!.id;
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Scanner", password: "scan123" } })).cookie!;
  const put = (page: number, body: unknown, cookie = adminCookie) => call(lan, `/api/admin/ocr/${pdf}/pages/${page}`, { method: "PUT", body, cookie });
  const frames = (await call(lan, `/api/ocr/${pdf}/boxes/1`, { cookie: readerCookie })).status; // before anything was read
  expect(frames).toBe(404);
  expect((await call(lan, `/api/ocr/${pdf}/boxes`, { cookie: readerCookie })).body).toEqual({ pages: [] }); // a book with none says so, it is not an error
  expect((await call(lan, "/api/ocr/nope/boxes", { cookie: readerCookie })).status).toBe(404);

  await call(lan, `/api/admin/ocr/${pdf}/start`, { body: { pages: 3, lang: "rus" }, cookie: adminCookie });
  const boxes = [["Лампа", 0.1, 0.2, 0.3, 0.25], ["схема", 0.32, 0.2, 0.5, 0.25]];
  expect((await put(1, { text: "Лампа схема", boxes })).body).toEqual({ done: 1, pages: 3 });
  expect((await put(2, { text: "Без рамок" })).status).toBe(200); // a recognizer that sends no frames still works

  expect((await call(lan, `/api/ocr/${pdf}/boxes`, { cookie: readerCookie })).body).toEqual({ pages: [1] }); // page 2 was read without frames
  // which books have pages to make selectable, and a start that takes those pages up again
  const listed = (await call(lan, "/api/admin/ocr", { cookie: adminCookie })).body.books.find((b: { id: string }) => b.id === pdf);
  expect(listed).toMatchObject({ done: 2, plain: 1 });
  const start = (again?: unknown) => call(lan, `/api/admin/ocr/${pdf}/start`, { body: { pages: 3, lang: "rus", again }, cookie: adminCookie });
  expect((await start()).body).toEqual({ done: [1, 2] });
  expect((await start(true)).body).toEqual({ done: [1] });
  expect((await start("yes")).body).toEqual({ done: [1, 2] }); // only a true asks for it
  // the page's words, to a reader (they are as open as the book's text in the search)
  expect((await call(lan, `/api/ocr/${pdf}/boxes/1`, { cookie: readerCookie })).body).toEqual({ boxes });
  expect((await call(lan, `/api/ocr/${pdf}/boxes/2`, { cookie: readerCookie })).status).toBe(404); // none were sent
  expect((await call(lan, `/api/ocr/${pdf}/boxes/x`, { cookie: readerCookie })).status).toBe(404);
  expect((await call(lan, `/api/ocr/nope/boxes/1`, { cookie: readerCookie })).status).toBe(404);
  expect((await fetch(`${lan}/api/ocr/${pdf}/boxes/1`, { headers: { Cookie: readerCookie } })).headers.get("cache-control")).toBe("no-store");

  // frames of another shape are refused, and the text with them: a reading is kept whole or not at all
  for (const bad of ["Лампа", [["a", 1, 2, 3]], [["a", "0", 0, 1, 1]], { a: 1 }, null]) expect((await put(1, { text: "Испорчено", boxes: bad })).status).toBe(400);
  expect((await call(lan, `/api/ocr/${pdf}/boxes/1`, { cookie: readerCookie })).body).toEqual({ boxes });
  expect((await call(lan, `/api/admin/ocr/${pdf}/pages`, { cookie: adminCookie })).body.items[0].text).toBe("Лампа схема");
  expect((await put(1, { text: "x", boxes }, readerCookie)).status).toBe(403); // only the administrator writes them

  // a page written by hand shows no frames, and taking it back shows them again
  await call(lan, `/api/admin/ocr/${pdf}/edit/1`, { method: "PUT", body: { text: "Лампа, схема" }, cookie: adminCookie });
  expect((await call(lan, `/api/ocr/${pdf}/boxes/1`, { cookie: readerCookie })).status).toBe(404);
  expect((await call(lan, `/api/ocr/${pdf}/boxes`, { cookie: readerCookie })).body).toEqual({ pages: [] });
  await call(lan, `/api/admin/ocr/${pdf}/edit/1`, { method: "DELETE", cookie: adminCookie });
  expect((await call(lan, `/api/ocr/${pdf}/boxes/1`, { cookie: readerCookie })).body).toEqual({ boxes });

  await call(lan, `/api/admin/ocr/${pdf}`, { method: "DELETE", cookie: adminCookie }); // as it was
  expect((await call(lan, `/api/ocr/${pdf}/boxes/1`, { cookie: readerCookie })).status).toBe(404);
});

test("a page that has the PDF's own text is taken as it is: kept with the book and its file, shown to the editor, and not found twice by the search", async () => {
  const books = (await call(lan, "/api/library", { cookie: adminCookie })).body.books as { id: string; path: string }[];
  const pdf = books.find((b) => b.path === "sub/three.pdf")!.id;
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Scanner", password: "scan123" } })).cookie!;
  const send = (path: string, method: string, body?: unknown, cookie = adminCookie) => call(lan, `/api/admin/ocr/${pdf}${path}`, { method, body, cookie });
  await call(lan, "/api/admin/fulltext", { body: { enabled: true }, cookie: adminCookie });

  await send("/start", "POST", { pages: 3, lang: "rus" });
  expect((await send("/pages/1", "PUT", { text: "Собственный текст первой страницы", own: true })).body).toEqual({ done: 1, pages: 3 });
  await send("/pages/2", "PUT", { text: "Страница из картинки" });
  expect((await send("/pages/5", "PUT", { text: "x", own: true })).status).toBe(404); // not in the book
  expect((await send("/pages/1", "PUT", { text: 5, own: true })).status).toBe(400);
  expect((await send("/pages/1", "PUT", { text: "x", own: true }, readerCookie)).status).toBe(403);

  const items = (await send("/pages", "GET")).body.items;
  expect(items).toEqual([
    { page: 1, text: "Собственный текст первой страницы", edited: false, own: true },
    { page: 2, text: "Страница из картинки", edited: false },
  ]);
  const listed = (await call(lan, "/api/admin/ocr", { cookie: adminCookie })).body;
  expect(listed.books.find((b: { id: string }) => b.id === pdf)).toMatchObject({ done: 2, own: 1, plain: 1 });
  expect(listed.recognizedPages).toBe(1); // the own text is not among the pages read from pictures
  expect((await call(lan, "/api/fulltext?q=собственный")).body.books).toEqual([]); // the readings' search has nothing of it; the book's own index finds it
  expect((await call(lan, `/api/ocr/${pdf}/boxes`, { cookie: readerCookie })).body).toEqual({ pages: [] }); // no frames: the PDF has its own text layer there

  const text = await (await fetch(`${lan}/api/admin/ocr/${pdf}/text?format=md`, { headers: { Cookie: adminCookie } })).text();
  expect(text).toContain("## Page 1\n\nСобственный текст первой страницы");
  expect(text).toContain("## Page 2\n\nСтраница из картинки");

  await send("/edit/1", "PUT", { text: "Поправлено" });
  expect((await send("/edit/1", "DELETE")).body.page).toEqual({ page: 1, text: "Собственный текст первой страницы", edited: false, own: true });
  await call(lan, `/api/admin/ocr/${pdf}`, { method: "DELETE", cookie: adminCookie }); // as it was
});

test("the administrator corrects the text of a scanned page, takes the correction back, and saves the book as a file", async () => {
  const books = (await call(lan, "/api/library", { cookie: adminCookie })).body.books as { id: string; path: string; name: string }[];
  const pdf = books.find((b) => b.path === "sub/three.pdf")!.id;
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Scanner", password: "scan123" } })).cookie!;
  const send = (path: string, method: string, body?: unknown, cookie = adminCookie) => call(lan, `/api/admin/ocr/${pdf}${path}`, { method, body, cookie });
  await call(lan, "/api/admin/fulltext", { body: { enabled: true }, cookie: adminCookie });

  await send("/start", "POST", { pages: 3, lang: "rus" });
  await send("/pages/1", "PUT", { text: "Старый ламповый осцилограф" }); // read with a mistake
  await send("/pages/3", "PUT", { text: "Третья страница." });

  // what the editor asks for, and only the administrator may
  expect((await call(lan, `/api/admin/ocr/${pdf}/pages`, { cookie: readerCookie })).status).toBe(403);
  expect((await call(lan, `/api/admin/ocr/${pdf}/pages`)).status).toBe(401);
  expect((await send("/pages", "GET")).body).toMatchObject({ pages: 3, done: 2, edited: 0, items: [{ page: 1, text: "Старый ламповый осцилограф", edited: false }, { page: 3, text: "Третья страница.", edited: false }] });
  expect((await send("/pages?from=2&to=3", "GET")).body.items.map((i: { page: number }) => i.page)).toEqual([3]);
  expect((await send("/pages?from=0", "GET")).status).toBe(400);
  expect((await call(lan, "/api/admin/ocr/nope/pages", { cookie: adminCookie })).status).toBe(404);

  // a correction: searched at once, kept against a second reading, and counted
  expect((await send("/edit/1", "PUT", { text: "Старый ламповый осциллограф\nс экраном" }, readerCookie)).status).toBe(403);
  expect((await send("/edit/1", "PUT", { text: 5 })).status).toBe(400);
  expect((await send("/edit/4", "PUT", { text: "outside the book" })).status).toBe(404);
  expect((await send("/edit/1", "PUT", { text: "Старый ламповый осциллограф\nс экраном" })).body).toEqual({ done: 2, pages: 3, edited: 1 });
  expect((await send("/edit/2", "PUT", { text: "Вторая страница, написанная вручную." })).body).toEqual({ done: 3, pages: 3, edited: 2 }); // a page that was never read
  expect((await call(lan, "/api/fulltext?q=осциллограф")).body.books.map((b: { id: string }) => b.id)).toEqual([pdf]);
  expect((await call(lan, "/api/fulltext?q=осцилограф")).body.books).toEqual([]); // the mistake is gone from search
  await send("/pages/1", "PUT", { text: "Совсем другое чтение" });
  expect((await send("/pages", "GET")).body.items[0]).toEqual({ page: 1, text: "Старый ламповый осциллограф\nс экраном", edited: true });
  expect((await call(lan, "/api/admin/ocr", { cookie: adminCookie })).body.books.find((b: { id: string }) => b.id === pdf)).toMatchObject({ pages: 3, done: 3, edited: 2 });

  // the book as a file
  const file = await fetch(`${lan}/api/admin/ocr/${pdf}/text?format=md&lang=ru`, { headers: { Cookie: adminCookie } });
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(file.headers.get("content-disposition")).toContain("attachment");
  expect(file.headers.get("content-disposition")).toContain("filename*=UTF-8''three.md");
  expect(await file.text()).toBe("# three\n\n## Страница 1\n\nСтарый ламповый осциллограф\nс экраном\n\n## Страница 2\n\nВторая страница, написанная вручную.\n\n## Страница 3\n\nТретья страница.\n");
  const plain = await fetch(`${lan}/api/admin/ocr/${pdf}/text?format=txt`, { headers: { Cookie: adminCookie } });
  expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect((await plain.text()).startsWith("three\n\n[Page 1]\n\n")).toBe(true);
  expect((await send("/text?format=docx", "GET")).status).toBe(400);
  expect((await call(lan, `/api/admin/ocr/${pdf}/text`, { cookie: readerCookie })).status).toBe(403);

  // taking back: to what was read, or to unread for the page nobody had read
  expect((await send("/edit/1", "DELETE", undefined, readerCookie)).status).toBe(403);
  expect((await send("/edit/1", "DELETE")).body).toEqual({ page: { page: 1, text: "Старый ламповый осцилограф", edited: false } });
  expect((await send("/edit/2", "DELETE")).body).toEqual({ page: null });
  expect((await send("/edit/3", "DELETE")).status).toBe(404); // never corrected
  expect((await send("/pages", "GET")).body).toMatchObject({ done: 2, edited: 0 });
  expect((await call(lan, "/api/fulltext?q=осцилограф")).body.books).toHaveLength(1);

  await send("", "DELETE");
  await call(lan, "/api/admin/fulltext", { body: { enabled: false }, cookie: adminCookie });
});

test("the administrator keeps pictures cut from a scanned page, refers to them in the text, and takes them as a zip", async () => {
  const books = (await call(lan, "/api/library", { cookie: adminCookie })).body.books as { id: string; path: string }[];
  const pdf = books.find((b) => b.path === "sub/three.pdf")!.id;
  const readerCookie = (await call(lan, "/api/login", { body: { name: "Scanner", password: "scan123" } })).cookie!;
  const send = (path: string, method: string, body?: unknown, cookie = adminCookie) => call(lan, `/api/admin/ocr/${pdf}${path}`, { method, body, cookie });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(60).fill(3)]);
  const upload = (page: number | string, init: { type?: string; cookie?: string; body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {}) =>
    fetch(`${lan}/api/admin/ocr/${pdf}/images?page=${page}`, { method: "POST", headers: { "Content-Type": init.type ?? "image/png", Cookie: init.cookie ?? adminCookie, ...init.headers }, body: init.body ?? png });

  await send("/start", "POST", { pages: 3, lang: "rus" });
  expect((await upload(2, { cookie: readerCookie })).status).toBe(403);
  expect((await upload(2, { type: "image/jpeg" })).status).toBe(400);
  expect((await upload(2, { headers: { Origin: "http://evil.example" } })).status).toBe(400);
  expect((await upload(9)).status).toBe(400); // not a page of the book
  expect((await upload("x")).status).toBe(400);
  expect((await upload(2, { body: new Uint8Array([1, 2, 3]) })).status).toBe(400);
  const stored = await upload(2);
  expect(stored.status).toBe(200);
  expect(await stored.json()).toEqual({ name: "p002-1.png", page: 2, size: png.length });

  expect((await send("/images", "GET")).body).toEqual({ items: [{ name: "p002-1.png", page: 2, size: png.length }] });
  expect((await send("/pages", "GET")).body).toMatchObject({ images: [{ name: "p002-1.png", page: 2 }] }); // what the editor shows under the pages
  expect((await call(lan, "/api/admin/ocr", { cookie: adminCookie })).body.books.find((b: { id: string }) => b.id === pdf)).toMatchObject({ images: 1 });
  expect((await send("/images", "GET", undefined, readerCookie)).status).toBe(403);
  const served = await fetch(`${lan}/api/admin/ocr/${pdf}/images/p002-1.png`, { headers: { Cookie: adminCookie } });
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
  expect((await send("/images/p003-1.png", "GET")).status).toBe(404);
  expect((await send("/images/..%2Fx.png", "GET")).status).toBe(404); // only the names the server gives
  expect((await call(lan, `/api/admin/ocr/${pdf}/images/p002-1.png`, { cookie: readerCookie })).status).toBe(403);

  // the text refers to it; the file has it in a zip, plain text does not
  await send("/edit/2", "PUT", { text: "Схема усилителя.\n\n![Рис. 1](images/p002-1.png)" });
  const zip = await fetch(`${lan}/api/admin/ocr/${pdf}/text?format=zip&lang=ru`, { headers: { Cookie: adminCookie } });
  expect(zip.headers.get("content-type")).toBe("application/zip");
  expect(zip.headers.get("content-disposition")).toContain("filename*=UTF-8''three.zip");
  const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  expect(Object.keys(files).sort()).toEqual(["book.md", "images/p002-1.png"]);
  expect(strFromU8(files["book.md"]!)).toBe("# three\n\n> Распознано страниц: 1 из 3.\n\n## Страница 2\n\nСхема усилителя.\n\n![Рис. 1](images/p002-1.png)\n");
  expect(await (await fetch(`${lan}/api/admin/ocr/${pdf}/text?format=txt`, { headers: { Cookie: adminCookie } })).text()).toBe("three\n\nRecognized pages: 1 of 3.\n\n[Page 2]\n\nСхема усилителя.\n");

  // deleting it takes the reference out of the page
  expect((await send("/images/p002-1.png", "DELETE", undefined, readerCookie)).status).toBe(403);
  expect((await send("/images/p002-1.png", "DELETE")).body).toEqual({ pages: [{ page: 2, text: "Схема усилителя.", edited: true }] });
  expect((await send("/images/p002-1.png", "DELETE")).status).toBe(404);
  expect((await send("/images", "GET")).body).toEqual({ items: [] });

  await send("", "DELETE");
});

test("the scripts that write a PDF are served from a fixed list, to anybody, with no way to reach other files", async () => {
  for (const name of ["pdf-lib.min.js", "fontkit.umd.min.js"]) {
    const res = await fetch(`${lan}/pdflib/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await res.text()).length).toBeGreaterThan(400_000);
  }
  expect((await fetch(`${lan}/pdflib/pdf-lib.esm.min.js`)).status).toBe(404);
  expect((await fetch(`${lan}/pdflib/..%2Fpackage.json`)).status).toBe(404);
  expect((await fetch(`${lan}/pdflib/`)).status).toBe(404);
});

test("the engine that reads pictures is served from a fixed list, to anybody, with no way to reach other files", async () => {
  for (const [name, type, least] of [["worker.min.js", "text/javascript", 10_000], ["tesseract.min.js", "text/javascript", 10_000], ["core/tesseract-core-simd-lstm.wasm.js", "text/javascript", 1_000_000], ["lang/rus.traineddata.gz", "application/octet-stream", 1_000_000], ["lang/eng.traineddata.gz", "application/octet-stream", 1_000_000]] as const) {
    const res = await fetch(`${lan}/ocr/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(least);
  }
  expect((await fetch(`${lan}/ocr/lang/deu.traineddata.gz`)).status).toBe(404);
  expect((await fetch(`${lan}/ocr/..%2Fpackage.json`)).status).toBe(404);
  expect((await fetch(`${lan}/ocr/`)).status).toBe(404);
});
