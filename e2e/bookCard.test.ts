import { expect } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Browser, BrowserContext } from "playwright-core";
import { epub } from "./fixtures";
import { ADMIN, after, api, before, e2e, FOLIATE_RACE, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

/** An EPUB whose package file names a title, an author, a year and a series, under a file name that says none of it. */
function scan(): Uint8Array {
  const files = unzipSync(epub("Placeholder"));
  const opf = strFromU8(files["OEBPS/content.opf"]!).replace(
    /<dc:title>[^<]*<\/dc:title>/,
    `<dc:title>Как сделать детекторный приёмник</dc:title><dc:creator>И. Г. Беляев</dc:creator><dc:date>1949</dc:date><meta name="calibre:series" content="Массовая радиобиблиотека"/>`,
  );
  files["OEBPS/content.opf"] = strToU8(opf);
  return zipSync({ ...files, mimetype: [files.mimetype!, { level: 0 }] });
}

before(async () => {
  browser = await launch();
  inst = await startServer({ "Scans/scan0042.epub": scan(), "Scans/plain.txt": "just text" });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

/** Waits until the server has read the EPUB's package file: that goes on after the first listing. */
async function titleRead(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const { books } = await api<{ books: { id: string; name: string; title: string }[] }>(ctx, inst, "/api/library");
    const book = books.find((b) => b.name === "scan0042");
    if (book && book.title !== book.name) return book.id;
    await Bun.sleep(250);
  }
  throw new Error("the title was never read");
}

e2e("a book is shown by its own title, found by its author, and its file's name stays in the reader's bar", async () => {
  const id = await titleRead();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#folder=Scans`);
  await page.waitForSelector(".card:not(.folder)");

  // the shelf shows the title (a text file keeps its file's name), with the file's path as a hint
  const shelf = () => page.$$eval(".card:not(.folder) .name", (spans) => spans.map((s) => s.textContent!).sort());
  expect(await shelf()).toEqual(["plain", "Как сделать детекторный приёмник"].sort());
  expect(await page.getAttribute(".card:has-text('детекторный')", "title")).toBe("Scans/scan0042.epub");
  // and so does the tree of folders
  await page.click("#panel-toggle").catch(() => {}); // the panel may be open already on a wide window
  expect(await page.textContent(".tree")).toContain("Как сделать детекторный приёмник");

  // the author and the series are found though the file's name says none of it
  await page.fill("#search", "беляев");
  await page.waitForSelector("#search-results li .name");
  expect(await page.textContent("#search-results")).toContain("Как сделать детекторный приёмник");
  await page.fill("#search", "радиобиблиотека");
  await page.waitForFunction(() => document.querySelector("#search-results")?.textContent?.includes("детекторный"));

  // the reader's bar names the book by its title and still tells where the file lies
  await page.goto(`${inst.url}/#book=${id}`);
  await page.waitForSelector(".reader-bar .title");
  expect(await page.textContent(".reader-bar .title")).toBe("Как сделать детекторный приёмник");
  expect(await page.textContent(".reader-bar .path")).toBe("Scans/scan0042.epub");
  expect(await page.title()).toContain("Как сделать детекторный приёмник");

  // a title typed by the administrator wins over the file's, and taking it back brings the file's title again
  const put = (body: unknown) => ctx.request.put(`${inst.url}/api/admin/books/${id}/meta`, { data: body, headers: { Origin: inst.url } });
  expect((await put({ set: { title: "Детекторный приёмник (Беляев)", tags: ["радио"] } })).status()).toBe(200);
  await page.goto(`${inst.url}/#folder=Scans`);
  await page.reload(); // a change of the address after the # does not load the list again
  await page.waitForSelector(".card:not(.folder)");
  expect(await shelf()).toEqual(["plain", "Детекторный приёмник (Беляев)"].sort());
  expect((await put({ reset: ["title"] })).status()).toBe(200);
  await page.reload();
  await page.waitForSelector(".card:not(.folder)");
  expect(await shelf()).toEqual(["plain", "Как сделать детекторный приёмник"].sort());
  expect(errors).toEqual([]);
  await page.close();
});

e2e("the administrator changes a book's details in its window, takes a typed value back to what the file says, and a reader only reads them", async () => {
  const id = await titleRead();
  // start from what the files say: the test above left a tag typed
  await ctx.request.put(`${inst.url}/api/admin/books/${id}/meta`, { data: { reset: ["title", "authors", "year", "series", "description", "language", "tags"] }, headers: { Origin: inst.url } });
  const page = await ctx.newPage();
  const errors = watchErrors(page, FOLIATE_RACE);
  await page.goto(`${inst.url}/#book=${id}`);
  await page.waitForSelector(".reader-bar .title");
  await page.click("[data-tour=card]");
  await page.waitForSelector(".card-form");

  // what the file says is in the form, and nothing is marked as typed
  expect(await page.inputValue(".card-form .card-field:nth-child(1) input")).toBe("Как сделать детекторный приёмник");
  expect(await page.inputValue(".card-form textarea >> nth=0")).toBe("И. Г. Беляев");
  expect(await page.inputValue(".card-form input[type=number]")).toBe("1949");
  expect(await page.$(".card-reset")).toBeNull();
  expect(await page.textContent(".card-file")).toContain("Scans/scan0042.epub");

  // a title and tags typed here: the window says saved, the reader's bar follows at once, and the file's own title is remembered beside it
  await page.fill(".card-form .card-field:nth-child(1) input", "Мой приёмник");
  await page.fill(".card-form .card-field:nth-child(6) input", "радио, схемы, Радио");
  await page.click(".card-form button[type=submit]");
  await page.waitForSelector(".card-saved:not([hidden])");
  expect(await page.textContent(".reader-bar .title")).toBe("Мой приёмник");
  expect(await page.inputValue(".card-form .card-field:nth-child(6) input")).toBe("радио, схемы"); // the repeated tag is gone
  expect(await page.textContent(".card-form .card-field:nth-child(1) .card-note")).toContain("Как сделать детекторный приёмник");
  expect(await page.locator(".card-reset").count()).toBe(2); // the title and the tags were typed here

  // a value the server refuses is explained and nothing else is lost
  await page.fill(".card-form input[type=number]", "1949.5");
  await page.click(".card-form button[type=submit]");
  await page.waitForSelector(".card-form .project-missing:not([hidden])");
  expect(await page.textContent(".card-form .project-missing")).toContain("whole number");
  expect(await page.inputValue(".card-form .card-field:nth-child(1) input")).toBe("Мой приёмник");
  await page.fill(".card-form input[type=number]", "1950");

  // taking the title back brings the file's title; the year typed but not saved stays in its box
  await page.click(".card-form .card-field:nth-child(1) .card-reset");
  await page.waitForFunction(() => document.querySelector(".reader-bar .title")?.textContent === "Как сделать детекторный приёмник");
  expect(await page.inputValue(".card-form .card-field:nth-child(1) input")).toBe("Как сделать детекторный приёмник");
  expect(await page.inputValue(".card-form input[type=number]")).toBe("1950");
  await page.keyboard.press("Escape");
  expect(await page.$(".modal")).toBeNull();

  // a reader (no administrator) can open the window, but only to read
  await api(ctx, inst, "/api/admin/users", { name: "Reader", password: "pin123", role: "user" });
  const readerCtx = await signedIn(browser, inst, { name: "Reader", password: "pin123" });
  const reader = await readerCtx.newPage();
  const readerErrors = watchErrors(reader);
  await reader.goto(`${inst.url}/#folder=Scans`);
  await reader.waitForSelector(".card:not(.folder)");
  await reader.click(".card:has-text('детекторный') .card-info");
  await reader.waitForSelector(".card-read");
  expect(await reader.evaluate(() => location.hash)).toBe("#folder=Scans"); // the ⓘ did not open the book
  expect(await reader.$(".card-form")).toBeNull();
  const shown = await reader.textContent(".modal");
  expect(shown).toContain("И. Г. Беляев");
  expect(shown).toContain("1949"); // the file's year: the 1950 typed above was never saved
  expect(shown).not.toContain("1950");
  expect(await reader.$$eval(".card-tag", (links) => links.map((a) => a.textContent))).toEqual(["радио", "схемы"]); // the tags are links to the books that have them
  expect(shown).toContain("Only an administrator");
  expect(errors).toEqual([]);
  expect(readerErrors).toEqual([]);
  await readerCtx.close();
  await page.close();
});
