import { expect } from "bun:test";
import { strToU8, zipSync } from "fflate";
import type { Browser, BrowserContext } from "playwright-core";
import { ADMIN, after, api, before, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

/** A small EPUB whose chapters say what is given. */
function epubOf(chapters: string[]): Uint8Array {
  const items = chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8(`<package><manifest>${items}</manifest><spine>${spine}</spine></package>`),
  };
  chapters.forEach((c, i) => (files[`OEBPS/c${i}.xhtml`] = strToU8(`<html><body><p>${c}</p></body></html>`)));
  return zipSync(files);
}

const filler = "lorem ipsum dolor sit amet ".repeat(70); // about two chunks of the index
before(async () => {
  browser = await launch();
  inst = await startServer({
    "Books/valves.txt": Array.from({ length: 9 }, (_, i) => `${filler}\n\nThe pentode stage number ${i}.`).join("\n\n"),
    "Books/radio.txt": "A pentode in a radio.",
    "Books/Pentode catalogue.txt": "only the name says it",
    "Docs/tubes.epub": epubOf(["First chapter about triodes.", "Second chapter about the pentode."]),
  });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

async function indexed(): Promise<void> {
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  for (let i = 0; i < 120; i++) {
    const res = await ctx.request.get(`${inst.url}/api/admin/fulltext`);
    const status = (await res.json()) as { total: number; indexed: number };
    if (status.total > 0 && status.indexed === status.total) return;
    await Bun.sleep(250);
  }
  throw new Error("the books were never indexed");
}

e2e("the page of results lists books by name and by what is inside them, with places, all places of one book, and filters kept in the address", async () => {
  await indexed();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#search=pentode`);
  await page.waitForSelector(".found-book");
  await page.waitForFunction(() => document.querySelectorAll(".found-book").length === 3);
  expect(await page.$$eval(".found-names .card.row .name", (n) => n.map((x) => x.childNodes[0]!.textContent))).toEqual(["Pentode catalogue"]); // found by its name
  expect(await page.inputValue("#search")).toBe("pentode"); // the search box says what was asked
  expect(await page.textContent(".found-names .card.row .added")).not.toContain("Invalid"); // the line of the list has its date, as on a shelf

  // a few places of a long book, and a button for the rest
  const valves = page.locator(".found-book:has(.found-name:text-is('valves'))");
  expect(await valves.locator(".found-hit").count()).toBe(5);
  await valves.locator(".found-more").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".found-book")].some((b) => b.querySelector(".found-name")?.textContent === "valves" && b.querySelectorAll(".found-hit").length > 5));
  expect(await valves.locator(".found-more").isHidden()).toBe(true);
  expect(await valves.locator(".found-hit mark").first().textContent()).toBe("pentode");

  // an EPUB's place is its section, and the link opens the book there
  const tubes = page.locator(".found-book:has(.found-name:text-is('tubes'))");
  expect(await tubes.locator(".found-where").textContent()).toBe("Section 2");
  expect(await tubes.locator(".found-hit").getAttribute("href")).toContain("view=");
  expect(await tubes.locator(".found-more").isHidden()).toBe(true);

  // a filter by format narrows both lists and is written into the address; reloading keeps it
  await page.selectOption(".bar-format", "epub");
  await page.waitForFunction(() => document.querySelectorAll(".found-book").length === 1);
  expect(await page.$(".found-names .card.row")).toBeNull();
  expect(await page.evaluate(() => location.hash)).toBe("#search=pentode&format=epub");
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".found-book").length === 1);
  expect(await page.inputValue(".bar-format")).toBe("epub");

  // nothing found says so
  await page.goto(`${inst.url}/#search=zzzzqq`);
  await page.reload();
  await page.waitForSelector(".shelf-empty:not([hidden])");
  expect(await page.textContent(".shelf-empty")).toBe("Nothing found for “zzzzqq”");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("Enter in the search box opens the page of results, an arrow and Enter jump to a book, and with the index off the page says so", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(`${inst.url}/#folder=Books`);
  await page.waitForSelector(".shelf");
  await page.fill("#search", "pentode");
  await page.waitForSelector("#search-results li.all-results");
  await page.keyboard.press("Enter"); // nothing was chosen with an arrow: all results
  await page.waitForSelector(".search-page");
  expect(await page.evaluate(() => location.hash)).toBe("#search=pentode");

  await page.goto(`${inst.url}/#folder=Books`);
  await page.reload();
  await page.waitForSelector(".shelf");
  await page.fill("#search", "radio");
  await page.waitForSelector("#search-results li[data-index]");
  await page.keyboard.press("ArrowDown"); // a chosen hit: a jump to the book
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.startsWith("#book="));
  expect(await page.$(".search-page")).toBeNull();

  // the page says what is searched when the index is off (and an administrator is told where to turn it on)
  await api(ctx, inst, "/api/admin/fulltext", { enabled: false });
  await page.goto(`${inst.url}/#search=pentode`);
  await page.reload();
  await page.waitForSelector(".found-content .muted");
  expect(await page.textContent(".found-content")).toContain("You can turn it on in Settings");
  expect(await page.$$eval(".found-names .card.row .name", (n) => n.map((x) => x.childNodes[0]!.textContent))).toEqual(["Pentode catalogue"]);
  expect(errors).toEqual([]);
  await page.close();
});
