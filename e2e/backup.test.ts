import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { library } from "./fixtures";
import { ADMIN, api, bookId, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let old: Instance;
let fresh: Instance;
let file: string;

beforeAll(async () => {
  browser = await launch();
  old = await startServer(library());
  fresh = await startServer(library());
  await setup(old);
});
afterAll(async () => {
  await browser?.close();
  await old?.stop();
  await fresh?.stop();
});

test("a backup downloaded from one installation restores on a new one from its first-run screen", async () => {
  const admin = await signedIn(browser, old);
  const reader = await browser.newContext();
  await reader.request.post(`${old.url}/api/register`, { data: { name: "Reader", password: "pin123" }, headers: { Origin: old.url } });
  const id = await bookId(admin, old, "Docs/notes.txt");
  await reader.request.post(`${old.url}/api/bookmarks`, { data: { bookId: id, label: "chapter five", view: { v: 1, offset: 10 } }, headers: { Origin: old.url } });
  await api(admin, old, "/api/shares", { bookId: id, view: null, expiresInDays: null });
  await api(admin, old, "/api/admin/settings", { lanAccess: "login", allowRegistration: false });

  const page = await admin.newPage();
  await page.goto(old.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Settings')");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("a:has-text('Download a backup')")]);
  file = join(old.data, "downloaded-backup.json");
  await download.saveAs(file);
  expect(download.suggestedFilename()).toMatch(/^tapalog-reader-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.users.map((u: { name: string }) => u.name)).toEqual(["Alex", "Reader"]);
  expect(JSON.stringify(saved)).not.toContain("secret1"); // hashes, not passwords
  await admin.close();
  await reader.close();

  // the new installation: nobody has an account yet
  const ctx = await browser.newContext();
  const fp = await ctx.newPage();
  const errors = watchErrors(fp);
  await fp.goto(fresh.url + "/");
  const chooser = fp.waitForEvent("filechooser");
  await fp.click("button:has-text('Restore from a backup')");
  await (await chooser).setFiles(file);
  await fp.waitForSelector("form button[type=submit]:has-text('Sign in')");
  await fp.fill("input[autocomplete=username]", "alex");
  await fp.fill("input[autocomplete=current-password]", ADMIN.password); // the old password still works
  await fp.click("form button[type=submit]");
  await fp.waitForSelector(".account .who");
  expect(await fp.textContent(".account .who")).toBe("Alex");

  const adminHere = await signedIn(browser, fresh);
  const settings = await api<{ lanAccess: string; allowRegistration: boolean; users: { name: string }[] }>(adminHere, fresh, "/api/admin/settings");
  expect(settings).toMatchObject({ lanAccess: "login", allowRegistration: false });
  expect(settings.users.map((u) => u.name)).toEqual(["Alex", "Reader"]);
  const readerHere = await signedIn(browser, fresh, { name: "Reader", password: "pin123" });
  expect((await api<{ bookmarks: { label: string }[] }>(readerHere, fresh, "/api/bookmarks")).bookmarks.map((b) => b.label)).toEqual(["chapter five"]);
  expect((await api<{ shares: unknown[] }>(adminHere, fresh, "/api/shares")).shares).toHaveLength(1);
  expect(errors).toEqual([]);
  await adminHere.close();
  await readerHere.close();
  await ctx.close();
});

test("restoring from Settings asks first, keeps the administrator signed in, and refuses a file that is not a backup", async () => {
  const admin = await signedIn(browser, fresh);
  const page = await admin.newPage();
  await page.goto(fresh.url + "/");
  await page.waitForSelector(".shelf");

  await page.click("button:has-text('Settings')");
  let asked = "";
  page.once("dialog", (d) => ((asked = d.message()), void d.accept()));
  const chooser = page.waitForEvent("filechooser");
  await page.click("button:has-text('Restore from a file')");
  await (await chooser).setFiles(file);
  await page.waitForSelector("text=Restored:");
  expect(asked).toContain("Replace all accounts");
  await page.waitForLoadState("load");
  await page.waitForSelector(".account .who"); // the page reloaded and the administrator is still in
  expect(await page.textContent(".account .who")).toBe("Alex");

  const notBackup = join(fresh.data, "not-a-backup.json");
  writeFileSync(notBackup, JSON.stringify({ hello: "world" }));
  await page.click("button:has-text('Settings')");
  const chooser2 = page.waitForEvent("filechooser");
  await page.click("button:has-text('Restore from a file')");
  await (await chooser2).setFiles(notBackup);
  await page.waitForSelector(".modal-body .error:has-text('not a Tapalog Reader backup')");
  await admin.close();
});
