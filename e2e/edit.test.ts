import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { ADMIN, api, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let page: Page;
let errors: string[];

beforeAll(async () => {
  browser = await launch();
  inst = await startServer({ "Books/first.txt": "the first book, long enough to have its own id", "Books/second.txt": "the second book, also with its own id", "Demo/Sub/deep.txt": "a book in a nested folder", "Empty/": "" });
  await setup(inst);
  ctx = await signedIn(browser, inst);
  page = await ctx.newPage();
  errors = watchErrors(page);
});
afterAll(async () => {
  await browser?.close();
  await inst?.stop();
});

const ls = (path = "") => {
  try {
    return readdirSync(join(inst.lib, ...path.split("/").filter(Boolean))).sort();
  } catch {
    return [];
  }
};
const node = (selector: string) => page.locator(`.tree .node${selector}`);
const toasts = () => page.$$eval(".toast", (t) => t.map((x) => x.textContent));
const settle = () => page.waitForTimeout(700);
const expand = async (folder: string) => {
  if (!(await page.$(`.tree .node[data-folder='${folder}'] + ul, .tree li:has(> .node[data-folder='${folder}']) > ul`))) await node(`[data-folder='${folder}'] .twisty`).click();
};

test("the administrator can switch to edit mode, a reader cannot", async () => {
  const reader = await browser.newContext();
  await reader.request.post(`${inst.url}/api/register`, { data: { name: "Reader", password: "pin1234" }, headers: { Origin: inst.url } });
  const rp = await reader.newPage();
  await rp.goto(inst.url + "/");
  await rp.waitForSelector(".account .who");
  expect(await rp.$("button:has-text('Edit')")).toBeNull();
  expect((await reader.request.post(`${inst.url}/api/admin/fs/mkdir`, { data: { parent: "", name: "x" }, headers: { Origin: inst.url } })).status()).toBe(403);
  await reader.close();

  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Edit')");
  await page.waitForSelector(".root-drop");
  expect(await page.$$eval("[draggable='true']", (n) => n.length)).toBeGreaterThan(0);
});

test("dragging a book onto a folder moves the file", async () => {
  await expand("Books");
  await node("[data-drag-path='Books/first.txt']").dragTo(node("[data-drop='Empty']"));
  await settle();
  expect(ls("Books")).toEqual(["second.txt"]);
  expect(ls("Empty")).toEqual(["first.txt"]);
});

test("dragging a folder moves it with everything inside, and a folder cannot go into itself", async () => {
  await expand("Demo");
  await node("[data-drag-path='Demo/Sub']").dragTo(node("[data-drop='Empty']"));
  await settle();
  expect(ls("Demo")).toEqual([]);
  expect(ls("Empty")).toEqual(["Sub", "first.txt"]);
  expect(ls("Empty/Sub")).toEqual(["deep.txt"]);

  await expand("Empty");
  await node("[data-drag-path='Empty']").dragTo(node("[data-drop='Empty/Sub']"));
  await settle();
  expect(ls()).toEqual(["Books", "Demo", "Empty"]);
});

test("dropping on the Library row brings an item back to the top level", async () => {
  await node("[data-drag-path='Empty/Sub']").dragTo(node(".root-drop"));
  await settle();
  expect(ls()).toEqual(["Books", "Demo", "Empty", "Sub"]);
});

test("renaming keeps the extension, and a name that is taken is refused with a message", async () => {
  page.once("dialog", (d) => void d.accept("Renamed"));
  await node("[data-drag-path='Books/second.txt'] .label").dblclick();
  await settle();
  expect(ls("Books")).toEqual(["Renamed.txt"]);

  // another book appears in the same folder (as if copied in with the file manager)
  writeFileSync(join(inst.lib, "Books", "Other.txt"), "a book that arrived from outside");
  await ctx.request.post(`${inst.url}/api/rescan`, { data: {}, headers: { Origin: inst.url } });
  await page.waitForTimeout(1500);
  await page.reload();
  await page.click("button:has-text('Edit')");
  await expand("Books");
  page.once("dialog", (d) => void d.accept("Other"));
  await node("[data-drag-path='Books/Renamed.txt']").hover();
  await page.click("[data-drag-path='Books/Renamed.txt'] button[data-act='rename']");
  await settle();
  expect((await toasts()).at(-1)).toContain("already there");
  expect(ls("Books")).toEqual(["Other.txt", "Renamed.txt"]);
});

test("the move dialog works without dragging", async () => {
  await expand("Sub");
  await node("[data-drag-path='Sub/deep.txt']").hover();
  await page.click("[data-drag-path='Sub/deep.txt'] button[data-act='move']");
  await page.waitForSelector(".move-list");
  const rows = await page.$$eval(".move-row", (b) => b.map((x) => (x as HTMLButtonElement).textContent + ((x as HTMLButtonElement).disabled ? " (x)" : "")));
  expect(rows.some((r) => r.includes("Sub") && r.includes("(x)"))).toBe(true); // it is there already
  await page.click(".move-row:has-text('Demo')");
  await settle();
  expect(ls("Demo")).toEqual(["deep.txt"]);
  expect(ls("Sub")).toEqual([]);
});

test("a new folder is created in the open folder; a bad name is refused", async () => {
  await page.goto(`${inst.url}/#folder=Demo`);
  await page.waitForSelector(".edit-bar button");
  page.once("dialog", (d) => void d.accept("Fresh"));
  await page.click(".edit-bar button");
  await settle();
  expect(ls("Demo")).toEqual(["Fresh", "deep.txt"]);

  page.once("dialog", (d) => void d.accept("bad/name"));
  await page.click(".edit-bar button");
  await settle();
  expect((await toasts()).at(-1)).toContain("not allowed");
  expect(ls("Demo")).toEqual(["Fresh", "deep.txt"]);
});

test("leaving edit mode removes the controls, and nothing broke on the way", async () => {
  await page.click("button:has-text('Done')");
  expect(await page.$$eval("[draggable='true']", (n) => n.length)).toBe(0);
  expect(errors).toEqual([]);
  expect((await api<{ books: unknown[] }>(ctx, inst, "/api/library")).books.length).toBe(4); // the same books, found again where they now are
});
