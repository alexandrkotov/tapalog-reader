import { expect } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { library } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let pdfId = "";
let txtId = "";

before(async () => {
  browser = await launch();
  inst = await startServer(library());
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  pdfId = await bookId(ctx, inst, "Docs/pages.pdf");
  txtId = await bookId(ctx, inst, "Docs/notes.txt");
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const titles = (page: Page) => page.$$eval(".project-item .project-go", (els) => els.map((e) => e.textContent));
const libraryHas = async (path: string) => (await api<{ books: { path: string }[] }>(ctx, inst, "/api/library")).books.some((b) => b.path === path);
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(what);
}

e2e("a project is built, ordered and edited on its screen, opens books where they were saved and says when a book is gone", async () => {
  const made = await api(ctx, inst, "/api/projects", { title: "My amplifier", description: "Two stages" });
  const id = made.project.id;
  const add = (body: unknown) => api(ctx, inst, `/api/projects/${id}/items`, body);
  await add({ bookId: pdfId, view: { v: 1, page: 4 }, title: "Schematic", comment: "second stage" });
  await add({ bookId: txtId, view: { v: 1 }, title: "Coil table", quote: "turns per layer" });
  await add({ title: "Check the values" });

  // a book that is in the library now and gone later
  const lost = join(inst.lib, "Docs", "lost.txt");
  writeFileSync(lost, "a book that will not stay\n");
  await until(() => libraryHas("Docs/lost.txt"), "the new book never appeared");
  const lostId = await bookId(ctx, inst, "Docs/lost.txt");
  await add({ bookId: lostId, view: { v: 1 }, title: "From the lost book", quote: "kept words" });
  unlinkSync(lost);
  await until(async () => !(await libraryHas("Docs/lost.txt")), "the removed book never left the library");

  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.click("button:has-text('My projects')");
  await page.waitForSelector(".project-row");
  expect(await page.textContent(".project-row .project-go")).toBe("My amplifier");
  expect(await page.textContent(".project-row .project-about")).toBe("Two stages");

  await page.click(".project-row .project-go");
  await page.waitForSelector(".project-item");
  expect(await titles(page)).toEqual(["Schematic", "Coil table", "Check the values", "From the lost book"]);
  expect(await page.textContent(".project-title")).toBe("My amplifier");
  expect(await page.textContent(".project-quote")).toBe("turns per layer");
  expect(await page.textContent(".project-comment")).toBe("second stage");
  expect(await page.textContent(".project-missing")).toContain("no longer in the library");
  expect(await page.$$eval(".project-item", (rows) => rows.map((r) => !!r.querySelector("button.project-go")))).toEqual([true, true, false, false]); // a note and a lost book open nothing
  expect(await page.$eval(".project-item:first-child button[title='Move up']", (b) => (b as HTMLButtonElement).disabled)).toBe(true);
  expect(await page.$eval(".project-item:last-child button[title='Move down']", (b) => (b as HTMLButtonElement).disabled)).toBe(true);

  // order
  await page.click(".project-item:first-child button[title='Move down']");
  await page.waitForFunction(() => document.querySelector(".project-item .project-go")?.textContent === "Coil table");
  expect(await titles(page)).toEqual(["Coil table", "Schematic", "Check the values", "From the lost book"]);
  expect((await api(ctx, inst, `/api/projects/${id}`)).items.map((i: { title: string }) => i.title)[0]).toBe("Coil table"); // kept on the server, not only drawn

  // edit an item and the project itself
  await page.click(".project-item:nth-child(2) button[title='Edit']");
  await page.fill(".project-edit input", "Schematic of the output stage");
  await page.fill(".project-edit textarea", "third stage");
  await page.click(".project-edit button[type=submit]");
  await page.waitForFunction(() => [...document.querySelectorAll(".project-item .project-go")].some((e) => e.textContent === "Schematic of the output stage"));
  expect(await page.$$eval(".project-comment", (els) => els.map((e) => e.textContent))).toContain("third stage");
  await page.click(".project-head button[title='Edit']");
  await page.fill(".project-edit input", "Amplifier v2");
  await page.click(".project-edit button[type=submit]");
  await page.waitForFunction(() => document.querySelector(".project-title")?.textContent === "Amplifier v2");

  // own note
  await page.fill(".project-add input", "Order the parts");
  await page.fill(".project-add textarea", "capacitors first");
  await page.click(".project-add button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll(".project-item").length === 5);
  expect((await titles(page)).at(-1)).toBe("Order the parts");

  // delete an item
  await page.click(".project-item:last-child button[title='Delete']");
  await page.waitForFunction(() => document.querySelectorAll(".project-item").length === 4);

  // an item opens its book where it was saved
  await page.click(".project-item:nth-child(2) button.project-go");
  await page.waitForSelector(".pdf-scroll .page canvas");
  expect(await page.$(".modal")).toBeNull();
  expect(await page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value)).toBe("4");

  // back on the list, a project is deleted after asking
  await page.click("button:has-text('My projects')");
  await page.waitForSelector(".project-row");
  page.once("dialog", (d) => void d.dismiss());
  await page.click(".project-row button[title='Delete']");
  expect(await page.$$(".project-row")).toHaveLength(1); // kept when the question is declined
  page.once("dialog", (d) => void d.accept());
  await page.click(".project-row button[title='Delete']");
  await page.waitForSelector(".project-list .muted");
  expect(await page.textContent(".project-list .muted")).toContain("No projects yet");
  expect((await api(ctx, inst, "/api/projects")).projects).toEqual([]);
  expect(errors).toEqual([]);
  await page.close();
});
