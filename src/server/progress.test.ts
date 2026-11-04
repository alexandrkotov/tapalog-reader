import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { openDb } from "./db";
import { MAX_PROGRESS, ProgressStore } from "./progress";
import { removeDir } from "./testutil";

const dir = mkdtempSync(join(tmpdir(), "reader-progress-"));
const db = openDb(dir);
const auth = new Auth(db);
const store = new ProgressStore(db);
afterAll(() => {
  db.close();
  removeDir(dir);
});

const id = (n: number) => n.toString(16).padStart(20, "0");

test("the last place saved is the one that stays, and opening without a place keeps it", async () => {
  const a = await auth.createUser("A", "secret1", "admin");
  store.save(a.id, id(1), { v: 1, page: 2 }, "Page 2", 1000);
  store.save(a.id, id(1), { v: 1, page: 7 }, "Page 7", 2000);
  expect(store.get(a.id, id(1))).toEqual({ bookId: id(1), view: { v: 1, page: 7 }, label: "Page 7", updatedAt: 2000 });
  store.save(a.id, id(1), undefined, "", 3000);
  expect(store.get(a.id, id(1))).toEqual({ bookId: id(1), view: { v: 1, page: 7 }, label: "Page 7", updatedAt: 3000 });
  expect(() => store.save(a.id, id(1), { blob: "x".repeat(5000) })).toThrow("view too large");
});

test("the list is most recently read first and each reader has their own", async () => {
  const b = await auth.createUser("B", "secret1", "user");
  const c = await auth.createUser("C", "secret1", "user");
  store.save(b.id, id(1), { v: 1 }, "", 10);
  store.save(b.id, id(2), { v: 1 }, "", 30);
  store.save(b.id, id(3), { v: 1 }, "", 20);
  expect(store.recent(b.id).map((p) => p.bookId)).toEqual([id(2), id(3), id(1)]);
  expect(store.recent(b.id, 2)).toHaveLength(2);
  expect(store.recent(c.id)).toEqual([]);
  expect(store.get(c.id, id(2))).toBeNull();
  expect(store.remove(c.id, id(2))).toBe(false);
  expect(store.remove(b.id, id(2))).toBe(true);
  expect(store.recent(b.id).map((p) => p.bookId)).toEqual([id(3), id(1)]);
});

test("only the most recent books are remembered", async () => {
  const d = await auth.createUser("D", "secret1", "user");
  for (let i = 0; i < MAX_PROGRESS + 5; i++) store.save(d.id, id(i), { v: 1 }, "", 1000 + i);
  const list = store.recent(d.id);
  expect(list).toHaveLength(MAX_PROGRESS);
  expect(list[0]!.bookId).toBe(id(MAX_PROGRESS + 4));
  expect(store.get(d.id, id(0))).toBeNull();
});

test("a deleted account takes its places with it", async () => {
  const e = await auth.createUser("E", "secret1", "user");
  store.save(e.id, id(1), { v: 1 });
  db.run("DELETE FROM users WHERE id = ?", [e.id]);
  expect((db.query("SELECT COUNT(*) AS n FROM progress WHERE user_id = ?").get(e.id) as { n: number }).n).toBe(0);
});
