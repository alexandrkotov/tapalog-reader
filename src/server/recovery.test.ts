import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { openDb } from "./db";
import { Recovery } from "./recovery";
import { removeDir } from "./testutil";

let data: string;
let db: ReturnType<typeof openDb>;
let auth: Auth;
let clock: number;
let recovery: Recovery;

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "reader-recovery-"));
  db = openDb(data);
  auth = new Auth(db);
  await auth.createUser("Alex", "old-secret", "admin");
  await auth.createUser("Reader", "pin123", "user");
  clock = 1_000_000;
  recovery = new Recovery(data, auth, () => clock);
});
afterEach(() => {
  db.close();
  removeDir(data);
});

const written = () => readFileSync(recovery.file, "utf-8").match(/(\d{4})-(\d{4})/)!.slice(1).join("-");

test("the code goes into a file, resets the administrator's password and is used up", async () => {
  expect(existsSync(recovery.file)).toBe(false);
  recovery.start();
  const done = await recovery.finish("alex", written(), "new-secret", "a");
  expect(done).toMatchObject({ user: { name: "Alex", role: "admin" } });
  expect(await auth.verify("Alex", "new-secret", "k")).not.toBeNull();
  expect(await auth.verify("Alex", "old-secret", "k")).toBeNull();
  expect(existsSync(recovery.file)).toBe(false);
  expect(await recovery.finish("Alex", "0000-0000", "again-1", "a")).toBe("wrong");
});

test("a code that is still valid is kept, an expired one is removed", async () => {
  recovery.start();
  const first = written();
  clock += 60_000;
  recovery.start();
  expect(written()).toBe(first);
  clock += 15 * 60_000;
  expect(await recovery.finish("Alex", first, "new-secret", "a")).toBe("wrong");
  expect(existsSync(recovery.file)).toBe(false);
});

test("only an administrator can be reset this way, and a wrong code changes nothing", async () => {
  recovery.start();
  expect(await recovery.finish("Reader", written(), "new-secret", "a")).toBe("wrong");
  expect(await recovery.finish("nobody", written(), "new-secret", "a")).toBe("wrong");
  expect(await recovery.finish("Alex", written().replace(/^\d/, (d) => String((Number(d) + 1) % 10)), "new-secret", "a")).toBe("wrong");
  expect(await auth.verify("Reader", "pin123", "k")).not.toBeNull();
  expect(await auth.verify("Alex", "old-secret", "k")).not.toBeNull();
});

test("without a code nothing works, and the digits can be typed with or without the dash", async () => {
  expect(await recovery.finish("Alex", "00000000", "new-secret", "a")).toBe("wrong");
  recovery.start();
  expect(await recovery.finish("Alex", written().replace("-", " "), "new-secret", "a")).toMatchObject({ user: { name: "Alex" } });
});

test("one guesser is held up after five wrong codes while the administrator can still use the code", async () => {
  recovery.start();
  for (let i = 0; i < 5; i++) expect(await recovery.finish("Alex", "0000-000" + i, "x-secret", "stranger")).toBe("wrong");
  expect(await recovery.finish("Alex", written(), "x-secret", "stranger")).toBe("locked");
  expect(await recovery.finish("Alex", written(), "new-secret", "admin")).toMatchObject({ user: { name: "Alex" } });
});

test("many wrong codes from many visitors burn the code", async () => {
  recovery.start();
  for (let i = 0; i < 30; i++) await recovery.finish("Alex", "0000-0000", "x-secret", "visitor" + i);
  expect(existsSync(recovery.file)).toBe(false);
  expect(await recovery.finish("Alex", "0000-0000", "x-secret", "late")).toBe("wrong");
});

test("a code file left by an earlier run is removed at start", () => {
  recovery.start();
  expect(existsSync(recovery.file)).toBe(true);
  new Recovery(data, auth);
  expect(existsSync(recovery.file)).toBe(false);
});
