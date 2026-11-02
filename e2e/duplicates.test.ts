import { expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { after, before, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

const SAME = "%PDF-1.4 one and the same book " + "x".repeat(2000);

let browser: Browser;
let inst: Instance;

before(async () => {
  browser = await launch();
  inst = await startServer({
    "Radio/Schemes 1957.pdf": SAME,
    "Old/Schemes copy.pdf": SAME,
    "Old/Third.pdf": SAME,
    "Handbook.pdf": "%PDF-1.4 handbook as a pdf",
    "Old/handbook.epub": "PK handbook as an epub",
    "Unique/Different.pdf": "%PDF-1.4 nothing like the others",
  });
  await setup(inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("duplicates are listed, a copy is moved to the trash and one copy always stays", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  page.on("dialog", (dialog) => void dialog.accept()); // the confirmation before anything is moved
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Settings')");
  await page.click("button:has-text('Find duplicates')");

  await page.waitForSelector("h3:has-text('Identical files')");
  await page.waitForSelector("h3:has-text('Alike names')");
  const rows = page.locator(".dup-row");
  expect(await rows.count()).toBe(5); // three identical files and the two with alike names
  const boxes = page.locator(".dup-group").first().locator("input[type=checkbox]");
  expect(await boxes.count()).toBe(3);
  expect(await boxes.nth(0).isChecked()).toBe(false); // the first stays
  expect(await boxes.nth(1).isChecked()).toBe(true);
  expect(await boxes.nth(2).isChecked()).toBe(true);
  await boxes.nth(0).click(); // trying to take them all: the last box refuses
  expect(await boxes.nth(0).isChecked()).toBe(false);
  const alike = page.locator(".dup-group").nth(1).locator("input[type=checkbox]");
  expect(await alike.nth(0).isChecked()).toBe(false); // alike names are never pre-selected
  expect(await alike.nth(1).isChecked()).toBe(false);

  await page.click("button:has-text('Move to the trash (2)')");
  await page.waitForSelector("text=Moved to the trash: 2");
  await page.waitForSelector("h3:has-text('Alike names')");
  expect(await page.locator("h3:has-text('Identical files')").count()).toBe(0); // one copy is left: nothing identical any more
  const kept = ["Radio/Schemes 1957.pdf", "Old/Schemes copy.pdf", "Old/Third.pdf"].filter((p) => existsSync(join(inst.lib, ...p.split("/"))));
  expect(kept).toEqual(["Old/Schemes copy.pdf"]); // the first of the group, by path, was the one left unchecked
  expect(readdirSync(join(inst.lib, ".tapalog-trash"))).toHaveLength(2);

  await ctx.close();
  expect(errors).toEqual([]);
});
