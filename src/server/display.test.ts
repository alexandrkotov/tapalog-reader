import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { openDb } from "./db";
import { DisplayStore, MAX_DISPLAY, parseDisplay } from "./display";
import { removeDir } from "./testutil";

const dir = mkdtempSync(join(tmpdir(), "reader-display-"));
const db = openDb(dir);
const auth = new Auth(db);
const store = new DisplayStore(db);
afterAll(() => {
  db.close();
  removeDir(dir);
});

const id = (n: number) => n.toString(16).padStart(20, "0");

test("only real settings are accepted, and ones that change nothing come out empty", () => {
  expect(parseDisplay({ rotation: 90 })).toEqual({ rotation: 90 });
  expect(parseDisplay({ rotation: 0 })).toEqual({});
  expect(parseDisplay({})).toEqual({});
  expect(parseDisplay({ rotation: 90, other: 1 })).toEqual({ rotation: 90 }); // unknown fields are dropped
  for (const bad of [null, undefined, "90", [], { rotation: 45 }, { rotation: "90" }, { rotation: -90 }, { rotation: 360 }]) expect(parseDisplay(bad)).toBeNull();
});

test("settings are kept per reader and book, replaced by the last save, and removed when they say nothing", async () => {
  const a = await auth.createUser("A", "secret1", "admin");
  const b = await auth.createUser("B", "secret2", "user");
  store.save(a.id, id(1), { rotation: 90 });
  store.save(a.id, id(1), { rotation: 180 });
  expect(store.get(a.id, id(1))).toEqual({ rotation: 180 });
  expect(store.get(b.id, id(1))).toBeNull();
  expect(store.get(a.id, id(2))).toBeNull();
  store.save(a.id, id(1), {});
  expect(store.get(a.id, id(1))).toBeNull();
  expect((db.query("SELECT COUNT(*) AS n FROM book_display").get() as { n: number }).n).toBe(0);
});

test("the least recently changed books are forgotten past the limit", async () => {
  const c = await auth.createUser("C", "secret3", "user");
  for (let n = 0; n < MAX_DISPLAY + 3; n++) store.save(c.id, id(n), { rotation: 90 }, 1000 + n);
  expect((db.query("SELECT COUNT(*) AS n FROM book_display WHERE user_id = ?").get(c.id) as { n: number }).n).toBe(MAX_DISPLAY);
  expect(store.get(c.id, id(0))).toBeNull();
  expect(store.get(c.id, id(MAX_DISPLAY + 2))).toEqual({ rotation: 90 });
});
