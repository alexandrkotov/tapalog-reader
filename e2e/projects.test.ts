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
  page.once("dialog", (d) => void d.dismiss());
  await page.click(".project-item:last-child button[title='Delete']");
  expect(await page.$$(".project-item")).toHaveLength(5); // kept when the question is declined
  page.once("dialog", (d) => void d.accept());
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
  await page.waitForFunction(() => !document.querySelector(".project-row")); // the list is drawn again without it
  expect(await page.textContent(".project-list .muted")).toContain("No projects yet");
  expect((await api(ctx, inst, "/api/projects")).projects).toEqual([]);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("project items of a PDF show a picture of their area (the whole page without one), turned as the reader turned the book", async () => {
  const made = await api(ctx, inst, "/api/projects", { title: "Pictures" });
  const id = made.project.id;
  const add = (body: unknown) => api(ctx, inst, `/api/projects/${id}/items`, body);
  // the red bar the fixture draws on page 5 lies at about x 0.13..0.25, y 0.64..0.76 of the page
  await add({ bookId: pdfId, view: { v: 1, page: 5, region: { x: 0.15, y: 0.66, w: 0.06, h: 0.09 } }, title: "The bar" });
  await add({ bookId: pdfId, view: { v: 1, page: 3 }, title: "A whole page" });
  await add({ bookId: txtId, view: { v: 1 }, title: "Some text" });
  await add({ title: "A note" });

  const shapes = (page: Page) =>
    page.$$eval(".project-item", (rows) =>
      rows.map((row) => {
        const canvas = row.querySelector<HTMLCanvasElement>(".project-thumb canvas");
        if (!canvas) return null;
        const px = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return { ratio: canvas.width / canvas.height, red: px[0]! > 150 && px[1]! < 100 && px[2]! < 100 };
      }),
    );
  const openProject = async (page: Page) => {
    await page.click("button:has-text('My projects')");
    await page.click(".project-row .project-go");
    await page.waitForSelector(".project-item");
  };

  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await openProject(page);
  await page.waitForFunction(() => document.querySelectorAll(".project-thumb canvas").length === 2);
  const [bar, whole, text, note] = await shapes(page);
  expect(bar!.ratio).toBeCloseTo((0.06 * 595) / (0.09 * 842), 1); // the area's own shape, not the page's
  expect(bar!.red).toBe(true); // and it is the area that is drawn: the middle of it is the red bar
  expect(whole!.ratio).toBeCloseTo(595 / 842, 1);
  expect(text).toBeNull();
  expect(note).toBeNull();

  // a picture opens the book where the item was saved
  await page.click(".project-item:first-child .project-thumb");
  await page.waitForSelector(".pdf-scroll .page canvas");
  expect(await page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value)).toBe("5");

  // the reader turned this book: the picture is turned the same way
  const turned = await ctx.request.put(`${inst.url}/api/display/${pdfId}`, { data: { display: { rotation: 90 } }, headers: { Origin: inst.url } });
  expect(turned.ok()).toBe(true);
  await openProject(page);
  await page.waitForFunction(() => document.querySelectorAll(".project-thumb canvas").length === 2);
  const [turnedBar, turnedWhole] = await shapes(page);
  expect(turnedBar!.ratio).toBeCloseTo((0.09 * 842) / (0.06 * 595), 1);
  expect(turnedBar!.red).toBe(true);
  expect(turnedWhole!.ratio).toBeCloseTo(842 / 595, 1);
  await ctx.request.put(`${inst.url}/api/display/${pdfId}`, { data: { display: {} }, headers: { Origin: inst.url } });
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a project is saved as a Markdown file whose links open the books where the items were saved", async () => {
  const made = await api(ctx, inst, "/api/projects", { title: "Export: amp", description: "For the bench" });
  const id = made.project.id;
  const add = (body: unknown) => api(ctx, inst, `/api/projects/${id}/items`, body);
  await add({ bookId: pdfId, view: { v: 1, page: 4 }, title: "Schematic", comment: "second stage" });
  await add({ bookId: txtId, view: { v: 1 }, title: "Coil table", quote: "turns per layer" });
  await add({ title: "Check the values", comment: "before power on" });

  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.click("button:has-text('My projects')");
  await page.click(".project-row .project-go");
  await page.waitForSelector(".project-item");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click(".project-head button[title='Save as a Markdown file']")]);
  expect(download.suggestedFilename()).toBe("Export amp.md"); // the colon is not allowed in a file name on every system
  const text = await Bun.file((await download.path())!).text();

  expect(text).toStartWith("# Export: amp\n\nFor the bench\n\n*Exported on ");
  expect(text).toContain(`from Tapalog Reader at ${inst.url}.`);
  expect(text).toContain("only while that server can be reached");
  expect(text.indexOf("## 1. Schematic")).toBeLessThan(text.indexOf("## 2. Coil table"));
  expect(text.indexOf("## 2. Coil table")).toBeLessThan(text.indexOf("## 3. Check the values"));
  expect(text).toContain("> turns per layer");
  expect(text).toContain("second stage");
  expect(text).toContain("_Note_");
  expect(text).toContain("**pages** (PDF)");
  expect(text).toContain("**notes** (TXT)");

  // the first link of the file opens the PDF on the page that was saved
  const href = /\[Open at the saved place\]\(([^)]+)\)/.exec(text)![1]!;
  expect(href.startsWith(inst.url + "/#book=")).toBe(true);
  await page.goto(href);
  await page.reload();
  await page.waitForSelector(".pdf-scroll .page canvas");
  expect(await page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value)).toBe("4");
  expect(errors).toEqual([]);
  await page.close();
});
