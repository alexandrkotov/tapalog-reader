import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { Backup, BackupError, parseBackup } from "./backup";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { Sources, SourceError } from "./sources";
import { removeDir } from "./testutil";

const base = mkdtempSync(join(tmpdir(), "reader-sources-"));
const open: ReturnType<typeof openDb>[] = [];
afterAll(() => {
  for (const db of open) db.close();
  removeDir(base);
});
let n = 0;

function install() {
  const dir = join(base, String(n++));
  mkdirSync(dir, { recursive: true });
  const db = openDb(dir);
  open.push(db);
  const config = new ConfigStore(dir);
  return { db, auth: new Auth(db), sources: new Sources(db), backup: new Backup(db, config) };
}
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (err) {
    return err instanceof SourceError ? err.code : String(err);
  }
};

test("sites are saved with a name, listed by name, and removed", () => {
  const { sources } = install();
  const b = sources.add("  Viacheslav's   books ", "https://www.facebook.com/1shirshov/");
  const a = sources.add("Archive", "https://example.org/library/?page=2");
  expect(b).toMatchObject({ name: "Viacheslav's books", url: "https://www.facebook.com/1shirshov/" }); // the name is tidied
  expect(sources.list().map((s) => s.name)).toEqual(["Archive", "Viacheslav's books"]);
  expect(sources.remove(a.id)).toBe(true);
  expect(sources.remove(a.id)).toBe(false);
  expect(sources.list()).toHaveLength(1);
});

test("only a plain http(s) address with a name is accepted, and the same address only once", () => {
  const { sources } = install();
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org/", "file:///etc/passwd", "https://user:pw@example.org/", "not a link", "", "https://" + "a".repeat(2100) + ".org"]) {
    expect(code(() => sources.add("x", bad))).toBe("bad-link");
  }
  expect(code(() => sources.add("x", 5))).toBe("bad-link");
  expect(code(() => sources.add("", "https://example.org/"))).toBe("invalid-name");
  expect(code(() => sources.add("   ", "https://example.org/"))).toBe("invalid-name");
  expect(code(() => sources.add("n".repeat(101), "https://example.org/"))).toBe("invalid-name");
  expect(code(() => sources.add(null, "https://example.org/"))).toBe("invalid-name");
  sources.add("One", "https://example.org/");
  expect(code(() => sources.add("Two", "https://example.org/"))).toBe("exists");
  expect(sources.list()).toHaveLength(1);
});

test("at most two hundred sites are kept", () => {
  const { sources } = install();
  for (let i = 0; i < 200; i++) sources.add(`Site ${i}`, `https://example.org/${i}`);
  expect(code(() => sources.add("One too many", "https://example.org/extra"))).toBe("too-many");
});

test("saved sites travel in a backup, and a backup from before they existed leaves them alone", async () => {
  const old = install();
  await old.auth.createUser("Alex", "secret1", "admin");
  old.sources.add("Facebook channel", "https://www.facebook.com/1shirshov/");
  const text = JSON.stringify(old.backup.create());
  expect(JSON.parse(text).sources).toEqual([{ name: "Facebook channel", url: "https://www.facebook.com/1shirshov/" }]);

  const fresh = install();
  fresh.sources.add("Local", "https://example.net/");
  fresh.backup.restore(parseBackup(JSON.parse(text)));
  expect(fresh.sources.list().map((s) => s.name)).toEqual(["Facebook channel"]); // replaced, like everything else in a backup

  const noSources = JSON.parse(text);
  delete noSources.sources;
  const other = install();
  other.sources.add("Kept", "https://example.com/");
  other.backup.restore(parseBackup(noSources));
  expect(other.sources.list().map((s) => s.name)).toEqual(["Kept"]);
});

test("a backup with a bad saved site is refused whole", () => {
  const { backup, auth } = install();
  void auth;
  const good = backup.create();
  const withUser = { ...good, users: [{ name: "Alex", hash: "$argon2id$v=19$m=65536,t=2,p=1$" + "a".repeat(40), role: "admin", createdAt: 1 }] };
  for (const sources of [[{ name: "x", url: "javascript:alert(1)" }], [{ name: "", url: "https://example.org/" }], "nope", [{ name: "a", url: "https://example.org/" }, { name: "b", url: "https://example.org/" }], [5]]) {
    expect(() => parseBackup({ ...withUser, sources })).toThrow(BackupError);
  }
  expect(parseBackup({ ...withUser, sources: [] }).sources).toEqual([]);
});
