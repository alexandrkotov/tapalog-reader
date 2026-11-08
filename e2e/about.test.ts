import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
const version = (JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;

before(async () => {
  browser = await launch();
  inst = await startServer({ "Books/a.txt": "book a" });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("the panel has a link to a window about the program: its version, licence, parts, and for the administrator where its files are", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about");
  expect(await page.textContent(".credit-about")).toBe("About");
  await page.waitForFunction((v) => document.querySelector<HTMLElement>(".credit-about")?.title === `Version ${v}`, version); // the version waits on the link as a hint

  await page.click(".credit-about");
  await page.waitForSelector(".modal .about-head");
  expect(await page.textContent(".modal .about-version")).toBe(`Version ${version}`);
  expect(await page.textContent(".modal .about-name")).toBe("Tapalog Reader");
  expect(await page.$$eval(".modal .about-links a", (a) => a.map((x) => x.getAttribute("href")))).toEqual([
    "https://tapalog.com",
    "https://github.com/alexandrkotov/tapalog-reader",
    "https://github.com/alexandrkotov/tapalog-reader/issues",
    "https://github.com/alexandrkotov/tapalog-reader/blob/main/LICENSE",
  ]);
  const parts = await page.$$eval(".modal .about-components li", (li) => li.map((x) => x.textContent!));
  expect(parts.some((x) => x.startsWith("pdf.js") && x.includes("Apache-2.0"))).toBe(true);
  expect(await page.textContent(".modal .about-data code")).toBe(inst.data); // the administrator is told where the program keeps its files
  await page.keyboard.press("Escape");
  expect(await page.$(".modal")).toBeNull();

  // a reader sees the same, without the folder
  await api(ctx, inst, "/api/admin/users", { name: "Reader", password: "pin123", role: "user" });
  const readerCtx = await signedIn(browser, inst, { name: "Reader", password: "pin123" });
  const reader = await readerCtx.newPage();
  await reader.goto(inst.url + "/");
  await reader.waitForSelector(".credit-about");
  await reader.click(".credit-about");
  await reader.waitForSelector(".modal .about-head");
  expect(await reader.textContent(".modal .about-version")).toBe(`Version ${version}`);
  expect(await reader.$(".modal .about-data")).toBeNull();
  expect(errors).toEqual([]);
  await readerCtx.close();
  await page.close();
});
