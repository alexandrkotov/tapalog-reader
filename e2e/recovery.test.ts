import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { library } from "./fixtures";
import { ADMIN, after, api, before, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;

before(async () => {
  browser = await launch();
  inst = await startServer(library());
  await setup(inst);
  const admin = await signedIn(browser, inst);
  await api(admin, inst, "/api/admin/settings", { lanAccess: "login" });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("an administrator who forgot the password gets back in with the code from the data folder", async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.click("button:has-text('Forgot the administrator password?')");
  await page.click("button:has-text('Get a code')");
  const file = join(inst.data, "reset-code.txt");
  await page.waitForSelector("text=A code was saved in this file");
  const code = readFileSync(file, "utf-8").match(/\d{4}-\d{4}/)![0];

  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Code from the file").fill("0000-0000");
  await page.getByLabel("New password").fill("brand-new-1");
  await page.click("button:has-text('Set the password')");
  await page.waitForSelector("text=Wrong code");

  await page.getByLabel("Code from the file").fill(code);
  await page.click("button:has-text('Set the password')");
  await page.waitForSelector(".shelf"); // signed in: the library is open
  expect(existsSync(file)).toBe(false);

  const again = await browser.newContext();
  const login = await again.request.post(`${inst.url}/api/login`, { data: { name: ADMIN.name, password: "brand-new-1" }, headers: { Origin: inst.url } });
  expect(login.ok()).toBe(true);
  expect(errors).toEqual([]);
  await ctx.close();
  await again.close();
});
