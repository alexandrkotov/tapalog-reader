import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { Library } from "./library";
import { startServers, type Servers } from "./server";
import { Shares } from "./shares";
import { TunnelController } from "./tunnelController";

let lib: string;
let data: string;
let servers: Servers;
let db: ReturnType<typeof openDb>;
let lan: string;
let tunnelSide: string; // the loopback socket the internet tunnel forwards to
const modes: string[] = [];

beforeAll(async () => {
  lib = mkdtempSync(join(tmpdir(), "reader-api-lib-"));
  data = mkdtempSync(join(tmpdir(), "reader-api-data-"));
  mkdirSync(join(lib, "sub"));
  writeFileSync(join(lib, "one.txt"), "first book, 0123456789");
  writeFileSync(join(lib, "sub/two.txt"), "second book");
  db = openDb(data);
  const config = new ConfigStore(data);
  const library = new Library(db, config, data);
  await library.setRoot(lib);
  servers = startServers(
    { library, auth: new Auth(db), shares: new Shares(db), config, tunnel: new TunnelController(() => "http://127.0.0.1:1"), lanUrls: () => [], setMode: (m) => modes.push(m) },
    { hostname: "127.0.0.1", port: 0 },
  );
  lan = `http://127.0.0.1:${servers.lan.port}`;
  tunnelSide = `http://127.0.0.1:${servers.internal.port}`;
});
afterAll(() => {
  servers.stop();
  rmSync(lib, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
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
