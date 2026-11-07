import { afterAll, beforeAll, expect, test } from "bun:test";
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
  bookId = library.body.books.find((b: { name: string }) => b.name === "one").id;

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

  expect((await call(lan, "/api/fulltext?q=first")).body).toEqual({ enabled: false, books: [] });
  expect((await call(lan, "/api/status")).body.fullText).toBe(false);

  expect((await call(lan, "/api/admin/fulltext", { body: { enabled: true }, cookie: adminCookie })).body.enabled).toBe(true);
  expect((await call(lan, "/api/status")).body.fullText).toBe(true);
  let found: { books: { name: string; hits: { snippet: string; view: unknown }[] }[] } = { books: [] };
  for (let i = 0; i < 200 && !found.books.length; i++) {
    await Bun.sleep(100); // indexing runs in the background; a slow runner needs seconds, not milliseconds
    found = (await call(lan, "/api/fulltext?q=second")).body;
  }
  expect(found.books[0]).toMatchObject({ name: "two", hits: [{ view: { v: 1, offset: 0, range: [0, 6] } }] });
  expect(found.books[0]!.hits[0]!.snippet).toBe("\u0001second\u0002 book");
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
  expect(list).toEqual({ plugins: [{ id: "demo", name: "Demo reader", version: "1.2.3", exts: ["demo", "dmo"], reader: "/plugins/demo/reader.js", shareableView: true, cover: false }] });

  expect((await call(lan, "/api/plugins", { cookie: "" })).body.plugins).toHaveLength(1); // no login needed: the page of a share link reads it too
  const reader = await fetch(lan + "/plugins/demo/reader.js");
  expect(reader.status).toBe(200);
  expect(reader.headers.get("content-type")).toBe("text/javascript");
  expect(reader.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await reader.text()).toContain("export function mount");
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
