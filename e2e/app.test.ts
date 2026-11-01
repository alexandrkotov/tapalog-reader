import { expect } from "bun:test";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { library } from "./fixtures";
import { after, before, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;

before(async () => {
  browser = await launch();
  inst = await startServer(library());
  await setup(inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

e2e("the theme can be switched between the system's, light and dark, and is remembered", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: "dark" }); // the system says dark
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "auto");

  expect(await theme()).toBe("auto");
  expect(await background()).toBe("rgb(20, 23, 28)"); // dark, as the system
  await page.selectOption("#theme", "light");
  expect(await theme()).toBe("light");
  expect(await background()).toBe("rgb(255, 255, 255)");
  await page.reload();
  await page.waitForSelector(".shelf");
  expect(await theme()).toBe("light"); // remembered
  await page.selectOption("#theme", "dark");
  expect(await theme()).toBe("dark");
  expect(await background()).toBe("rgb(20, 23, 28)");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await background()).toBe("rgb(20, 23, 28)"); // an explicit choice wins over the system
  await page.selectOption("#theme", "auto");
  expect(await theme()).toBe("auto");
  expect(await background()).toBe("rgb(255, 255, 255)"); // follows the system again (now light)
  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("the library folder is chosen by browsing the computer's folders, not by typing a path", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Settings')");
  await page.click("button:has-text('Browse')");
  await page.waitForFunction((lib) => document.querySelector(".folder-where")?.textContent === lib, inst.lib); // starts at the current library, once the list has come in
  await page.click(".folder-list button:has-text('Docs')");
  await page.waitForFunction((lib) => document.querySelector(".folder-where")?.textContent === lib, join(inst.lib, "Docs"));
  expect(await page.locator(".modal .muted.small").last().textContent()).toContain("2"); // Docs holds two books
  await page.click("button:has-text('Up')");
  await page.waitForFunction((lib) => document.querySelector(".folder-where")?.textContent === lib, inst.lib);
  await page.click(".folder-list button:has-text('Docs')");
  await page.waitForFunction((lib) => document.querySelector(".folder-where")?.textContent === lib, join(inst.lib, "Docs"));
  await page.click("button:has-text('Choose this folder')");
  expect(await page.locator(".modal input[type=text]").first().inputValue()).toBe(join(inst.lib, "Docs"));
  await page.click("button:has-text('Use this folder')");
  await page.waitForFunction(() => !document.querySelector(".tree")?.textContent?.includes("Comics")); // the library is Docs now
  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("the administrator can stop the server from the settings, on the computer it runs on", async () => {
  const own = await startServer(library());
  await setup(own);
  const ctx = await signedIn(browser, own);
  const page = await ctx.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(own.url + "/");
  await page.waitForSelector(".shelf");
  await page.click("button:has-text('Settings')");
  await page.click("button:has-text('Stop the server')");
  await page.waitForSelector("text=Tapalog Reader is stopped");
  let down = false;
  for (let i = 0; i < 50 && !down; i++) {
    down = await fetch(own.url + "/api/me").then(() => false, () => true);
    if (!down) await Bun.sleep(100);
  }
  expect(down).toBe(true);
  await ctx.close();
  await own.stop();
});
