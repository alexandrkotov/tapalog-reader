import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { Browser } from "playwright-core";
import { startFakeDrive } from "../src/server/fakeDrive";
import { library } from "./fixtures";
import { after, before, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

const PICTURE = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const BOOK = "%PDF-1.4 a book from the stand-in Drive";
const FB2 = "<?xml version='1.0'?><FictionBook>" + "text ".repeat(100) + "</FictionBook>";
const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456";

let browser: Browser;
let inst: Instance;
let drive: ReturnType<typeof startFakeDrive>;

before(async () => {
  browser = await launch();
  drive = startFakeDrive({ [ID]: { name: "Лучшие конструкции, 1957.pdf", content: BOOK }, PLAIN: { name: null, content: BOOK }, ZIPBOOK: { name: "Повесть.fb2.zip", content: new Uint8Array(zipSync({ "Повесть.fb2": strToU8(FB2) })), type: "application/zip" }, ZIPMANY: { name: "two.zip", content: new Uint8Array(zipSync({ "a.pdf": strToU8(BOOK), "b.fb2": strToU8(FB2) })) } }, PICTURE);
  inst = await startServer(library(), { TAPALOG_IMPORT_TEST_URL: drive.origin });
  await setup(inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
  drive?.stop();
});

e2e("a book from a Drive link (even one wrapped by Facebook) is previewed, renamed, put in a folder and downloaded", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");

  await page.click("button:has-text('Download by link')");
  const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(`https://drive.google.com/open?id=${ID}&usp=drive_fs&fbclid=x`)}&h=tracking`;
  await page.getByLabel("Link to the book file").fill("hello");
  await page.click("button:has-text('Check the link')");
  await page.waitForSelector("text=That is not a web link");
  await page.getByLabel("Link to the book file").fill("http://127.0.0.1:1/nope.pdf"); // a link into this very computer is refused
  await page.click("button:has-text('Check the link')");
  await page.waitForSelector("text=Links to this computer or to a local network are not allowed");
  expect(await page.locator(".modal a").count()).toBe(0); // no credits or other links in the dialog

  await page.getByLabel("Link to the book file").fill(wrapped);
  await page.click("button:has-text('Check the link')");
  const name = page.getByLabel("Name of the book");
  await name.waitFor();
  expect(await name.inputValue()).toBe("Лучшие конструкции, 1957"); // the suggestion, without the extension
  await page.waitForFunction(() => (document.querySelector(".import-cover") as HTMLImageElement | null)?.naturalWidth === 1); // the cover preview
  expect(await page.locator(".modal select").inputValue()).toBe(""); // the library's root by default

  await name.fill("Радиовыставка 1957");
  await page.locator(".modal select").selectOption("Docs");
  await page.click(".modal button:has-text('Download')");
  await page.waitForSelector("text=The book was saved as Docs/Радиовыставка 1957.pdf");
  expect(readFileSync(join(inst.lib, "Docs", "Радиовыставка 1957.pdf"), "utf-8")).toBe(BOOK);

  expect(errors).toEqual([]);
  await page.click("button:has-text('Open the book')");
  await page.waitForFunction(() => location.hash.startsWith("#book="));
  await page.waitForSelector(".node.selected[title='Docs/Радиовыставка 1957.pdf']"); // the new book is in the tree, selected

  // the same name again is refused before anything is fetched, and cancelling leaves nothing
  await page.click("button:has-text('Download by link')");
  await page.getByLabel("Link to the book file").fill(`https://drive.google.com/file/d/${ID}/view`);
  await page.click("button:has-text('Check the link')");
  await page.getByLabel("Name of the book").fill("Радиовыставка 1957");
  await page.locator(".modal select").selectOption("Docs");
  await page.click(".modal button:has-text('Download')");
  await page.waitForSelector("text=Something with that name is already there");
  expect(existsSync(join(inst.lib, "Docs", ".part"))).toBe(false);
  await ctx.close();
});

e2e("a book from the address of a file on any site is downloaded too, named after the address, without a picture", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");

  await page.click("button:has-text('Download by link')");
  await page.getByLabel("Link to the book file").fill(`${drive.origin}/files/PLAIN/Moi%20radio%201960.pdf?token=abc`);
  await page.click("button:has-text('Check the link')");
  const name = page.getByLabel("Name of the book");
  await name.waitFor();
  expect(await name.inputValue()).toBe("Moi radio 1960");
  expect(await page.locator(".import-cover").count()).toBe(0); // only Drive has a picture to show beforehand
  await page.click(".modal button:has-text('Download')");
  // the same content is already in the library (the first test saved it): the dialog says where and offers to keep it anyway
  await page.waitForSelector("text=This book is already in the library as Docs/Радиовыставка 1957.pdf");
  expect(existsSync(join(inst.lib, "Moi radio 1960.pdf"))).toBe(false);
  await page.click("button:has-text('Save anyway')");
  await page.waitForSelector("text=The book was saved as Moi radio 1960.pdf");
  expect(readFileSync(join(inst.lib, "Moi radio 1960.pdf"), "utf-8")).toBe(BOOK);

  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("the sites books are taken from are saved in the download dialog and are there next time", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Download by link')");
  await page.waitForSelector("text=Save the sites you take books from");

  await page.locator(".source-add input").first().fill("Facebook channel");
  await page.locator(".source-add input").nth(1).fill("javascript:alert(1)");
  await page.click("button:has-text('Save site')");
  await page.waitForSelector("text=That is not a web link");
  await page.locator(".source-add input").nth(1).fill("https://www.facebook.com/1shirshov/");
  await page.click("button:has-text('Save site')");
  const link = page.locator(".source-list a");
  await link.waitFor();
  expect(await link.textContent()).toBe("Facebook channel");
  expect(await link.getAttribute("href")).toBe("https://www.facebook.com/1shirshov/");
  expect(await link.getAttribute("target")).toBe("_blank");
  expect(await link.getAttribute("rel")).toContain("noopener");

  await page.locator(".source-add input").nth(1).fill("https://www.facebook.com/1shirshov/");
  await page.locator(".source-add input").first().fill("Again");
  await page.click("button:has-text('Save site')");
  await page.waitForSelector("text=That site is already in the list");

  await page.reload(); // still there next time, in a new dialog
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Download by link')");
  await page.waitForSelector(".source-list a");
  await page.click(".source-list button[title='Remove']");
  await page.waitForSelector("text=Save the sites you take books from");
  expect(await page.locator(".source-list a").count()).toBe(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("a zip with a book in it is unpacked after the download, and the type of the book is found from what is inside", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");

  await page.click("button:has-text('Download by link')");
  await page.getByLabel("Link to the book file").fill(`${drive.origin}/files/ZIPMANY/two.zip`);
  await page.click("button:has-text('Check the link')");
  await page.getByLabel("Name of the book").waitFor();
  await page.waitForSelector("text=A zip archive");
  await page.click(".modal button:has-text('Download')");
  await page.waitForSelector("text=The zip has several books in it");
  expect(existsSync(join(inst.lib, "two.fb2"))).toBe(false);

  await page.click("button:has-text('Back')");
  await page.getByLabel("Name of the book").waitFor();
  await page.click("button:has-text('Back')"); // to the link
  await page.getByLabel("Link to the book file").fill(`${drive.origin}/files/ZIPBOOK/anything`);
  await page.click("button:has-text('Check the link')");
  const name = page.getByLabel("Name of the book");
  await name.waitFor();
  expect(await name.inputValue()).toBe("Повесть"); // book.fb2.zip: named after the book
  await page.click(".modal button:has-text('Download')");
  await page.waitForSelector("text=The book was saved as Повесть.fb2");
  expect(readFileSync(join(inst.lib, "Повесть.fb2"), "utf-8")).toBe(FB2);
  expect(existsSync(join(inst.lib, "Повесть.zip"))).toBe(false);
  expect(errors).toEqual([]);
  await ctx.close();
});
