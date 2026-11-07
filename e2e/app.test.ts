import { expect } from "bun:test";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { library } from "./fixtures";
import { after, api, before, e2e, launch, setup, signedIn, startServer, watchErrors, type Instance } from "./harness";

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
  await page.click("button:text-is('↑ Up')");
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

e2e("the quick tour is offered once, lights up each button in turn and can be started again", async () => {
  const ctx = await signedIn(browser, inst, undefined, undefined, true);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".tour-offer");
  expect(await page.textContent(".credit")).toBe("Developed by Tapalog"); // the credit under the folders links to the project's site
  expect(await page.getAttribute(".credit a", "href")).toBe("https://tapalog.com");
  expect(await page.getAttribute(".credit a", "rel")).toContain("noopener");
  await page.click(".tour-offer >> text=No, thanks");
  expect(await page.locator(".tour-offer").count()).toBe(0);
  await page.reload();
  await page.waitForSelector(".shelf");
  expect(await page.locator(".tour-offer").count()).toBe(0); // asked once only

  await page.click("#tour");
  const total = Number((await page.textContent(".tour-count"))!.split(" of ")[1]);
  expect(total).toBeGreaterThanOrEqual(8); // the library panel, search, the administrator's buttons, theme and language
  const lit = async () => {
    await page.waitForTimeout(300); // the spotlight glides to the next button
    const hole = (await page.locator(".tour-hole").boundingBox())!;
    return page.evaluate((h) => {
      const near = (a: number, b: number) => Math.abs(a - b) <= 6;
      const match = [...document.querySelectorAll<HTMLElement>("#panel-toggle, #panel, #search, [data-tour], #theme, #lang")].find((n) => {
        const r = n.getBoundingClientRect();
        return near(r.left, h.x) && near(r.top, h.y) && near(r.width + 8, h.width) && near(r.height + 8, h.height);
      });
      return match ? match.id || match.dataset.tour! : null;
    }, hole);
  };
  const seen: (string | null)[] = [];
  for (let i = 0; i < total; i++) {
    seen.push(await lit());
    expect((await page.textContent(".tour-text"))!.length).toBeGreaterThan(10);
    const card = (await page.locator(".tour-card").boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.y).toBeGreaterThanOrEqual(0);
    await page.click(".tour-card .btn.primary");
  }
  expect(seen).toEqual(["panel-toggle", "panel", "search", "bookmarks", "projects", "links", "edit", "link", "settings", "theme", "lang"]);
  expect(await page.locator(".tour-card").count()).toBe(0); // the last step's button is "Done"

  await page.click("#tour");
  await page.keyboard.press("Escape");
  expect(await page.locator(".tour-card").count()).toBe(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

e2e("with a book open the tour is about reading it: the title, print, bookmarks, share and the reader's own buttons", async () => {
  const ctx = await signedIn(browser, inst);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf"); // the first scan is done
  const notes = (await api<{ books: { id: string; path: string }[] }>(ctx, inst, "/api/library")).books.find((b) => b.path.endsWith("notes.txt"))!; // an earlier test may have made Docs the library
  await page.goto(`${inst.url}/#book=${notes.id}`);
  await page.waitForSelector(".txt-body");
  await page.waitForSelector("[data-tour=print]:not([hidden])"); // shown when the reader says it can print
  await page.click("#tour");
  const total = Number((await page.textContent(".tour-count"))!.split(" of ")[1]);
  expect(total).toBe(6);
  const seen: (string | null)[] = [];
  for (let i = 0; i < total; i++) {
    await page.waitForTimeout(300);
    const hole = (await page.locator(".tour-hole").boundingBox())!;
    seen.push(
      await page.evaluate((h) => {
        const near = (a: number, b: number) => Math.abs(a - b) <= 6;
        const match = [...document.querySelectorAll<HTMLElement>(".reader-bar .title, [data-tour], .reader-host .pdf-toolbar, #tour")].find((n) => {
          const r = n.getBoundingClientRect();
          return near(r.left, h.x) && near(r.top, h.y) && near(r.width + 8, h.width) && near(r.height + 8, h.height);
        });
        return match ? match.dataset.tour || match.id || match.className.split(" ")[0]! : null;
      }, hole),
    );
    const card = (await page.locator(".tour-card").boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.y).toBeGreaterThanOrEqual(0);
    await page.click(".tour-card .btn.primary");
  }
  expect(seen).toEqual(["title", "print", "marks", "share", "pdf-toolbar", "tour"]);
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
