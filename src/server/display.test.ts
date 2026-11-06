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

test("a crop is checked, tidied, and a crop of the whole page is not kept", () => {
  const rect = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 };
  expect(parseDisplay({ crop: { all: rect } })).toEqual({ crop: { all: rect } });
  expect(parseDisplay({ rotation: 90, crop: { odd: rect, even: { x: 0, y: 0, w: 0.8, h: 1 } } })).toEqual({ rotation: 90, crop: { odd: rect, even: { x: 0, y: 0, w: 0.8, h: 1 } } });
  expect(parseDisplay({ crop: { all: { x: 0, y: 0, w: 1, h: 1 } } })).toEqual({}); // nothing is cut
  expect(parseDisplay({ crop: { all: { x: 0.12345678, y: 0, w: 0.5, h: 1 } } })).toEqual({ crop: { all: { x: 0.1235, y: 0, w: 0.5, h: 1 } } });
  expect(parseDisplay({ crop: {} })).toEqual({});
  expect(parseDisplay({ crop: { all: rect, middle: rect } })).toEqual({ crop: { all: rect } }); // unknown parts are dropped
  const bad = [
    { crop: "all" },
    { crop: [] },
    { crop: { all: null } },
    { crop: { all: { x: 0, y: 0, w: 1 } } },
    { crop: { all: { x: "0", y: 0, w: 1, h: 1 } } },
    { crop: { all: { x: -0.1, y: 0, w: 0.5, h: 0.5 } } },
    { crop: { all: { x: 0.6, y: 0, w: 0.6, h: 0.5 } } }, // runs off the page
    { crop: { all: { x: 0, y: 0, w: 0.01, h: 0.5 } } }, // a sliver
    { crop: { all: { x: 0, y: 0, w: Number.NaN, h: 0.5 } } },
    { crop: { odd: rect, even: { x: 0, y: 0, w: 0, h: 0 } } },
  ];
  for (const display of bad) expect(parseDisplay(display)).toBeNull();
});

test("a page offset is a whole number of pages, and zero is not kept", () => {
  expect(parseDisplay({ pageOffset: 12 })).toEqual({ pageOffset: 12 });
  expect(parseDisplay({ pageOffset: -4 })).toEqual({ pageOffset: -4 }); // a scan that starts at printed page 5
  expect(parseDisplay({ pageOffset: 0 })).toEqual({});
  expect(parseDisplay({ rotation: 90, pageOffset: 3, crop: { all: { x: 0, y: 0, w: 0.5, h: 1 } } })).toEqual({ rotation: 90, pageOffset: 3, crop: { all: { x: 0, y: 0, w: 0.5, h: 1 } } });
  for (const bad of [{ pageOffset: 1.5 }, { pageOffset: "3" }, { pageOffset: 10000 }, { pageOffset: -10000 }, { pageOffset: Number.NaN }, { pageOffset: null }]) expect(parseDisplay(bad)).toBeNull();
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
