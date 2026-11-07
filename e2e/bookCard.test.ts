import { expect } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Browser, BrowserContext } from "playwright-core";
import { epub } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

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
