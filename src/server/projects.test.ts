import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "./auth";
import { openDb } from "./db";
import { MAX_ITEMS, MAX_PROJECTS, MAX_TITLE, ProjectError, Projects } from "./projects";
import { removeDir } from "./testutil";

const dir = mkdtempSync(join(tmpdir(), "reader-projects-"));
const db = openDb(dir);
afterAll(() => {
  db.close();
  removeDir(dir);
});

const auth = new Auth(db);
const projects = new Projects(db);
const alex = await auth.createUser("Alex", "secret1", "admin");
const other = await auth.createUser("Other", "secret2", "user");
const BOOK = "0123456789abcdef0123";
const failure = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    if (err instanceof ProjectError) return err.message;
    throw err;
  }
  return "";
};

test("a project has a trimmed title and description, and an empty or too long title is refused", () => {
  const p = projects.create(alex.id, "  My amplifier  ", "  two stages  ");
  expect(p).toMatchObject({ title: "My amplifier", description: "two stages", items: 0 });
  expect(projects.get(alex.id, p.id)).toMatchObject({ title: "My amplifier" });
  expect(failure(() => projects.create(alex.id, "   "))).toBe("title required");
  expect(failure(() => projects.create(alex.id, "x".repeat(MAX_TITLE + 1)))).toBe("title too long");
  expect(failure(() => projects.create(alex.id, 5))).toBe("bad title");
});

test("a project of one reader does not exist for another", () => {
  const mine = projects.create(alex.id, "Private");
  projects.addItem(alex.id, mine.id, { title: "a note" });
  expect(projects.get(other.id, mine.id)).toBeNull();
  expect(projects.list(other.id)).toEqual([]);
  expect(projects.items(other.id, mine.id)).toBeNull();
  expect(projects.addItem(other.id, mine.id, { title: "intruder" })).toBeNull();
  expect(projects.update(other.id, mine.id, { title: "taken" })).toBe(false);
  expect(projects.remove(other.id, mine.id)).toBe(false);
  expect(projects.items(alex.id, mine.id)).toHaveLength(1);
  const item = projects.items(alex.id, mine.id)![0]!;
  expect(projects.updateItem(other.id, mine.id, item.id, { title: "taken" })).toBe(false);
  expect(projects.removeItem(other.id, mine.id, item.id)).toBe(false);
  expect(projects.reorder(other.id, mine.id, [item.id])).toBe(false);
  expect(projects.items(alex.id, mine.id)![0]!.title).toBe("a note");
});

test("items keep the place in the book, the quote and the comment; a note has no book", () => {
  const p = projects.create(alex.id, "Items");
  const view = { v: 1, page: 4, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } };
  const scheme = projects.addItem(alex.id, p.id, { bookId: BOOK, view, title: "  Schematic  ", comment: " the second stage ", quote: " passage " })!;
  expect(scheme).toMatchObject({ bookId: BOOK, view, title: "Schematic", comment: "the second stage", quote: "passage" });
  const note = projects.addItem(alex.id, p.id, { bookId: null, view: { v: 1, page: 9 }, title: "Check the values" })!;
  expect(note).toMatchObject({ bookId: null, view: null }); // a view without a book is dropped
  expect(projects.items(alex.id, p.id)!.map((i) => i.title)).toEqual(["Schematic", "Check the values"]);
  expect(projects.items(alex.id, p.id)![0]!.view).toEqual(view);
  expect(projects.get(alex.id, p.id)!.items).toBe(2);
  expect(failure(() => projects.addItem(alex.id, p.id, { bookId: BOOK, view: "page 4", title: "x" }))).toBe("bad view");
  expect(failure(() => projects.addItem(alex.id, p.id, { bookId: BOOK, view: { blob: "x".repeat(5000) }, title: "x" }))).toBe("bad view");
  expect(failure(() => projects.addItem(alex.id, p.id, { title: " " }))).toBe("title required");
  expect(failure(() => projects.addItem(alex.id, p.id, { title: "x", comment: "y".repeat(6000) }))).toBe("comment too long");
  expect(projects.items(alex.id, p.id)).toHaveLength(2); // the refused ones were not added
});

test("an item's title, comment and quote can be changed, its place cannot", () => {
  const p = projects.create(alex.id, "Edit");
  const view = { v: 1, page: 2 };
  const item = projects.addItem(alex.id, p.id, { bookId: BOOK, view, title: "Old", comment: "keep", quote: "q" })!;
  expect(projects.updateItem(alex.id, p.id, item.id, { title: "New" })).toBe(true);
  expect(projects.items(alex.id, p.id)![0]).toMatchObject({ title: "New", comment: "keep", quote: "q", view });
  expect(projects.updateItem(alex.id, p.id, item.id, { comment: "" })).toBe(true); // an empty comment clears it
  expect(projects.items(alex.id, p.id)![0]!.comment).toBe("");
  expect(failure(() => projects.updateItem(alex.id, p.id, item.id, { title: "  " }))).toBe("title required");
  expect(projects.updateItem(alex.id, p.id, 999999, { title: "x" })).toBe(false);
  expect(projects.update(alex.id, p.id, { description: "about" })).toBe(true);
  expect(projects.get(alex.id, p.id)).toMatchObject({ title: "Edit", description: "about" });
});

test("items can be put in a new order, but only by naming every one exactly once", () => {
  const p = projects.create(alex.id, "Order");
  const [a, b, c] = ["a", "b", "c"].map((title) => projects.addItem(alex.id, p.id, { title })!.id) as [number, number, number];
  expect(projects.reorder(alex.id, p.id, [c, a, b])).toBe(true);
  expect(projects.items(alex.id, p.id)!.map((i) => i.title)).toEqual(["c", "a", "b"]);
  expect(projects.reorder(alex.id, p.id, [a, b])).toBe(false); // one missing
  expect(projects.reorder(alex.id, p.id, [a, a, b])).toBe(false); // one twice
  expect(projects.reorder(alex.id, p.id, [a, b, c, 999999])).toBe(false);
  expect(projects.reorder(alex.id, p.id, [a, b, 999999])).toBe(false); // one that is not here
  expect(projects.items(alex.id, p.id)!.map((i) => i.title)).toEqual(["c", "a", "b"]);
  expect(projects.addItem(alex.id, p.id, { title: "d" })).not.toBeNull(); // new ones go to the end
  expect(projects.items(alex.id, p.id)!.map((i) => i.title)).toEqual(["c", "a", "b", "d"]);
  expect(projects.removeItem(alex.id, p.id, a)).toBe(true);
  expect(projects.removeItem(alex.id, p.id, a)).toBe(false);
  expect(projects.items(alex.id, p.id)!.map((i) => i.title)).toEqual(["c", "b", "d"]);
});

test("removing a project removes its items, and a changed project comes first in the list", async () => {
  const p = projects.create(alex.id, "Doomed");
  projects.addItem(alex.id, p.id, { title: "x" });
  const count = () => (db.query("SELECT COUNT(*) AS n FROM project_items WHERE project_id = ?").get(p.id) as { n: number }).n;
  expect(count()).toBe(1);
  await Bun.sleep(5);
  const fresh = projects.create(alex.id, "Newest");
  await Bun.sleep(5);
  projects.addItem(alex.id, p.id, { title: "y" }); // touching an old project brings it to the top
  expect(projects.list(alex.id)[0]!.id).toBe(p.id);
  expect(projects.list(alex.id).some((x) => x.id === fresh.id)).toBe(true);
  expect(projects.remove(alex.id, p.id)).toBe(true);
  expect(count()).toBe(0);
  expect(projects.get(alex.id, p.id)).toBeNull();
});

test("deleting an account deletes its projects", async () => {
  const gone = await auth.createUser("Gone", "secret3", "user");
  const p = projects.create(gone.id, "Mine");
  projects.addItem(gone.id, p.id, { title: "x" });
  auth.deleteUser(gone.id);
  expect((db.query("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(gone.id) as { n: number }).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM project_items WHERE project_id = ?").get(p.id) as { n: number }).n).toBe(0);
});

test("a reader cannot keep more than the limits allow", async () => {
  const crowd = await auth.createUser("Crowd", "secret4", "user");
  for (let i = 0; i < MAX_PROJECTS; i++) projects.create(crowd.id, `p${i}`);
  expect(failure(() => projects.create(crowd.id, "one more"))).toBe("too many");
  const p = projects.list(crowd.id)[0]!;
  for (let i = 0; i < MAX_ITEMS; i++) projects.addItem(crowd.id, p.id, { title: `i${i}` });
  expect(failure(() => projects.addItem(crowd.id, p.id, { title: "one more" }))).toBe("too many");
});
