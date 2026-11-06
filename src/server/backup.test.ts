import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { Backup, BackupError, parseBackup } from "./backup";
import { Bookmarks } from "./bookmarks";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { DisplayStore } from "./display";
import { ProgressStore } from "./progress";
import { Shares } from "./shares";
import { removeDir } from "./testutil";

const base = mkdtempSync(join(tmpdir(), "reader-backup-"));
const open: ReturnType<typeof openDb>[] = [];
afterAll(() => {
  for (const db of open) db.close();
  removeDir(base);
});
let n = 0;

function install() {
  const dir = join(base, String(n++));
  Bun.spawnSync(["mkdir", "-p", dir]);
  const db = openDb(dir);
  open.push(db);
  const config = new ConfigStore(dir);
  return { db, config, auth: new Auth(db), bookmarks: new Bookmarks(db), progress: new ProgressStore(db), display: new DisplayStore(db), shares: new Shares(db), backup: new Backup(db, config) };
}

const ID = "0123456789abcdef0123";

async function populated() {
  const a = install();
  const admin = await a.auth.createUser("Alex", "secret1", "admin");
  const reader = await a.auth.createUser("Reader", "pin123", "user");
  a.bookmarks.add(reader.id, ID, "chapter two", { v: 1, page: 2 });
  a.bookmarks.add(admin.id, ID, "mine", { v: 1, page: 9 });
  a.progress.save(reader.id, ID, { v: 1, page: 5 }, "Page 5");
  a.progress.save(admin.id, ID);
  a.display.save(reader.id, ID, { rotation: 270 });
  a.shares.create(ID, { v: 1, page: 3 }, reader.id, null);
  a.shares.create(ID, null, null, 7);
  a.config.update({ lanAccess: "login", allowRegistration: false, fullText: true });
  return { ...a, admin, reader };
}

test("a backup restores accounts with their passwords, bookmarks, links and settings on a new installation", async () => {
  const old = await populated();
  const text = JSON.stringify(old.backup.create());
  expect(text).not.toContain("secret1"); // hashes only, never passwords

  const fresh = install();
  const done = fresh.backup.restore(parseBackup(JSON.parse(text)));
  expect(done).toEqual({ users: 2, bookmarks: 2, shares: 2 });

  expect(await fresh.auth.verify("alex", "secret1", "k")).toMatchObject({ name: "Alex", role: "admin" });
  const reader = await fresh.auth.verify("Reader", "pin123", "k2");
  expect(reader).not.toBeNull();
  expect(fresh.bookmarks.list(reader!.id).map((b) => [b.label, b.view])).toEqual([["chapter two", { v: 1, page: 2 }]]);
  const links = fresh.shares.list("all");
  expect(links).toHaveLength(2);
  expect(links.find((l) => l.view)?.createdBy).toBe(reader!.id); // the author is found by name, not by an id that no longer exists
  expect(links.find((l) => !l.view)?.createdBy).toBeNull();
  expect(old.shares.list("all").map((l) => l.token).sort()).toEqual(links.map((l) => l.token).sort()); // the same links keep working
});

test("reading places come back with the backup, and a backup from before them leaves nobody with any", async () => {
  const old = await populated();
  const text = JSON.stringify(old.backup.create());
  const fresh = install();
  fresh.backup.restore(parseBackup(JSON.parse(text)));
  const reader = await fresh.auth.verify("Reader", "pin123", "k3");
  const admin = await fresh.auth.verify("Alex", "secret1", "k4");
  expect(fresh.progress.recent(reader!.id)).toMatchObject([{ bookId: ID, view: { v: 1, page: 5 }, label: "Page 5" }]);
  expect(fresh.progress.get(admin!.id, ID)).toMatchObject({ view: null }); // opened, no place

  const before = JSON.parse(text) as any;
  delete before.progress; // what a backup made by an earlier version looks like
  const other = install();
  const stranger = await other.auth.createUser("Stranger", "hunter22", "admin");
  other.progress.save(stranger.id, ID, { v: 1 });
  other.backup.restore(parseBackup(before));
  expect((other.db.query("SELECT COUNT(*) AS n FROM progress").get() as { n: number }).n).toBe(0);

  const broken = JSON.parse(text) as any;
  broken.progress[0].user = "Nobody";
  expect(() => parseBackup(broken)).toThrow(BackupError);
});

test("display settings come back with the backup, and a backup from before them leaves nobody with any", async () => {
  const old = await populated();
  const text = JSON.stringify(old.backup.create());
  const fresh = install();
  fresh.backup.restore(parseBackup(JSON.parse(text)));
  const reader = await fresh.auth.verify("Reader", "pin123", "k5");
  const admin = await fresh.auth.verify("Alex", "secret1", "k6");
  expect(fresh.display.get(reader!.id, ID)).toEqual({ rotation: 270 });
  expect(fresh.display.get(admin!.id, ID)).toBeNull();

  const before = JSON.parse(text) as any;
  delete before.display;
  const other = install();
  const stranger = await other.auth.createUser("Stranger", "hunter22", "admin");
  other.display.save(stranger.id, ID, { rotation: 90 });
  other.backup.restore(parseBackup(before));
  expect((other.db.query("SELECT COUNT(*) AS n FROM book_display").get() as { n: number }).n).toBe(0);

  for (const spoil of [(b: any) => (b.display[0].user = "Nobody"), (b: any) => (b.display[0].display = { rotation: 12 }), (b: any) => b.display.push(b.display[0])]) {
    const broken = JSON.parse(text) as any;
    spoil(broken);
    expect(() => parseBackup(broken)).toThrow(BackupError);
  }
});

test("restoring replaces what is there and signs everybody out", async () => {
  const old = await populated();
  const file = parseBackup(JSON.parse(JSON.stringify(old.backup.create())));
  const other = install();
  const stranger = await other.auth.createUser("Stranger", "hunter22", "admin");
  other.auth.startSession(stranger.id);
  other.bookmarks.add(stranger.id, ID, "gone", { v: 1 });

  other.backup.restore(file);
  expect(other.auth.listUsers().map((u) => u.name)).toEqual(["Alex", "Reader"]);
  expect((other.db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
  expect((other.db.query("SELECT COUNT(*) AS n FROM bookmarks WHERE label = 'gone'").get() as { n: number }).n).toBe(0);
});

test("expired links are not worth keeping", async () => {
  const a = await populated();
  a.shares.create(ID, null, a.admin.id, 1);
  expect(a.backup.create().shares).toHaveLength(3); // unlimited, 7 days, 1 day
  expect(a.backup.create(new Date(Date.now() + 3 * 86_400_000)).shares).toHaveLength(2); // three days on, the 1-day link has lapsed
  expect(a.backup.create(new Date(Date.now() + 30 * 86_400_000)).shares).toHaveLength(1);
});

test("anything that is not a backup this version understands is refused", async () => {
  const good = JSON.parse(JSON.stringify((await populated()).backup.create())) as any;
  const refuses = (mutate: (b: any) => void, code: string) => {
    const copy = structuredClone(good);
    mutate(copy);
    let got = "";
    try {
      parseBackup(copy);
    } catch (err) {
      got = err instanceof BackupError ? err.code : String(err);
    }
    expect(got).toBe(code);
  };
  expect(() => parseBackup(good)).not.toThrow();
  refuses((b) => (b.format = "something else"), "not-backup");
  refuses((b) => (b.version = 2), "version");
  refuses((b) => (b.users = b.users.filter((u: any) => u.role !== "admin")), "no-admin");
  refuses((b) => (b.users[0].hash = "plain text password"), "invalid");
  refuses((b) => (b.users[1].name = b.users[0].name.toUpperCase()), "invalid");
  refuses((b) => (b.users[0].role = "root"), "invalid");
  refuses((b) => (b.settings.mode = "everywhere"), "invalid");
  refuses((b) => (b.bookmarks[0].user = "Nobody"), "invalid");
  refuses((b) => (b.bookmarks[0].bookId = "../../etc"), "invalid");
  refuses((b) => (b.bookmarks[0].view = "x".repeat(5000)), "invalid");
  refuses((b) => (b.shares[1].token = b.shares[0].token), "invalid");
  refuses((b) => (b.shares[0].createdBy = "Nobody"), "invalid");
  refuses((b) => (b.shares = "no"), "invalid");
  expect(() => parseBackup(null)).toThrow(BackupError);
  expect(() => parseBackup([])).toThrow(BackupError);
});
