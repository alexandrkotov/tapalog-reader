import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { startFakeDrive } from "../src/server/fakeDrive";
import { library } from "./fixtures";
import { after, before, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

const PICTURE = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const BOOK = "%PDF-1.4 a book from the stand-in Drive";
const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456";

let browser: Browser;
let inst: Instance;
let drive: ReturnType<typeof startFakeDrive>;

before(async () => {
  browser = await launch();
  drive = startFakeDrive({ [ID]: { name: "Лучшие конструкции, 1957.pdf", content: BOOK } }, PICTURE);
  inst = await startServer(library(), { TAPALOG_DRIVE_TEST_URL: drive.origin });
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

  await page.click("button:has-text('Google Drive')");
  const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(`https://drive.google.com/open?id=${ID}&usp=drive_fs&fbclid=x`)}&h=tracking`;
  await page.getByLabel("Link to the file").fill("https://example.com/nope");
  await page.click("button:has-text('Check the link')");
  await page.waitForSelector("text=That is not a link to a file on Google Drive");

  await page.getByLabel("Link to the file").fill(wrapped);
  await page.click("button:has-text('Check the link')");
  const name = page.getByLabel("Name of the book");
  await name.waitFor();
  expect(await name.inputValue()).toBe("Лучшие конструкции, 1957"); // the suggestion, without the extension
  await page.waitForFunction(() => (document.querySelector(".drive-cover") as HTMLImageElement | null)?.naturalWidth === 1); // the cover preview
  expect(await page.locator(".modal select").inputValue()).toBe(""); // the library's root by default
  expect(await page.locator(".drive-thanks a").getAttribute("href")).toBe("https://www.facebook.com/1shirshov/");
  expect(await page.locator(".drive-thanks a").textContent()).toBe("Viacheslav Shirshov");

  await name.fill("Радиовыставка 1957");
  await page.locator(".modal select").selectOption("Docs");
  await page.click("button:has-text('Download')");
  await page.waitForSelector("text=The book was saved as Docs/Радиовыставка 1957.pdf");
  expect(readFileSync(join(inst.lib, "Docs", "Радиовыставка 1957.pdf"), "utf-8")).toBe(BOOK);

  expect(errors).toEqual([]);
  await page.click("button:has-text('Open the book')");
  await page.waitForFunction(() => location.hash.startsWith("#book="));
  await page.waitForSelector(".node.selected[title='Docs/Радиовыставка 1957.pdf']"); // the new book is in the tree, selected

  // the same name again is refused before anything is fetched, and cancelling leaves nothing
  await page.click("button:has-text('Google Drive')");
  await page.getByLabel("Link to the file").fill(`https://drive.google.com/file/d/${ID}/view`);
  await page.click("button:has-text('Check the link')");
  await page.getByLabel("Name of the book").fill("Радиовыставка 1957");
  await page.locator(".modal select").selectOption("Docs");
  await page.click("button:has-text('Download')");
  await page.waitForSelector("text=Something with that name is already there");
  expect(existsSync(join(inst.lib, "Docs", ".part"))).toBe(false);
  await ctx.close();
});
