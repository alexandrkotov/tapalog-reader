import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { NOTES_PHRASE, library } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, FOLIATE_RACE, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

before(async () => {
  browser = await launch();
  inst = await startServer(library());
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const openBook = async (path: string) => {
  const page = await ctx.newPage();
  const errors = watchErrors(page, FOLIATE_RACE);
  await page.goto(`${inst.url}/#book=${await bookId(ctx, inst, path)}`);
  await page.waitForSelector(".reader-bar");
  return { page, errors };
};

e2e("the first run asks for an administrator, then shows the library", async () => {
  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  await page.goto(inst.url + "/");
  await page.fill("input[autocomplete=username]", ADMIN.name);
  await page.fill("input[autocomplete=new-password]", ADMIN.password);
  await page.click("form button[type=submit]");
  await page.waitForSelector(".account .who");
  expect(await page.textContent(".account .who")).toBe(ADMIN.name);
  await page.waitForSelector(".tree .node"); // the name is drawn before the library has arrived
  expect(await page.$$eval(".tree .node", (n) => n.map((x) => (x as HTMLElement).dataset.folder))).toEqual(["Books", "Comics", "Docs"]);
  await fresh.close();
  ctx = await signedIn(browser, inst);
});

e2e("searching by file name finds a book and opens it", async () => {
  const page = await ctx.newPage();
  await page.goto(inst.url + "/");
  await page.waitForSelector(".shelf");
  await page.fill("#search", "hostile");
  await page.waitForSelector("#search-results li");
  expect(await page.textContent("#search-results")).toContain("Hostile"); // shown by the title the EPUB itself gives (the file is hostile.epub)
  await page.click("#search-results li");
  await page.waitForSelector(".reader-bar");
  expect(await page.textContent(".reader-bar .title")).toBe("Hostile");
  await page.close();
});

e2e("every format opens in its own reader without errors", async () => {
  const txt = await openBook("Docs/notes.txt");
  await txt.page.waitForSelector(".txt-body");
  expect(await txt.page.textContent(".txt-body")).toContain(NOTES_PHRASE);

  const pdf = await openBook("Docs/pages.pdf");
  await pdf.page.waitForSelector(".pdf-scroll .page canvas");
  expect(await pdf.page.textContent(".pdf-toolbar")).toContain("/ 12");

  for (const path of ["Books/story.epub", "Books/tale.fb2", "Comics/strip.cbz"]) {
    const book = await openBook(path);
    await book.page.waitForSelector("foliate-view");
    await book.page.waitForFunction(() => /%/.test(document.querySelector(".book-progress")?.textContent ?? ""));
    expect(book.errors).toEqual([]);
    await book.page.close();
  }
  expect(txt.errors).toEqual([]);
  expect(pdf.errors).toEqual([]);
});

e2e("scripts inside an EPUB do not run", async () => {
  const book = await openBook("Books/hostile.epub");
  await book.page.waitForFunction(() => /%/.test(document.querySelector(".book-progress")?.textContent ?? ""));
  await book.page.waitForTimeout(1000);
  expect(await book.page.title()).not.toContain("PWNED");
  await book.page.close();
});

e2e("page previews: a strip of pages, drawn as needed, that moves the reader", async () => {
  const { page } = await openBook("Docs/pages.pdf");
  await page.waitForSelector(".pdf-page-input");
  await page.click("button[title='Page previews']");
  await page.waitForSelector(".thumbs");
  expect(await page.$$eval(".thumb-cell", (c) => c.length)).toBe(12);
  await page.waitForSelector(".thumb-pic canvas");
  await page.click(".thumb-cell[data-n='7']");
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "7");
  expect(await page.$eval(".thumb-cell.current", (c) => (c as HTMLElement).dataset.n)).toBe("7");
  await page.click("button[title='Page previews']");
  expect(await page.$(".thumbs")).toBeNull();
  await page.close();
});

e2e("print: what is prepared is the chosen part, and a book's scripts are stripped", async () => {
  const printed = async (path: string, choose?: (page: import("playwright-core").Page) => Promise<void>) => {
    const { page } = await openBook(path);
    await page.evaluate(() => ((window as any).print = () => ((window as any).__printed = true))); // the print window cannot be driven here
    await page.waitForTimeout(1500);
    await page.click("button:has-text('Print')");
    await page.waitForSelector(".print-choices");
    await choose?.(page);
    await page.click(".modal .btn.primary");
    await page.waitForFunction(() => (window as any).__printed === true, null, { timeout: 60_000 });
    const summary = await page.evaluate(() => {
      const root = document.getElementById("print-root")!.shadowRoot!;
      return { images: root.querySelectorAll("img").length, text: root.textContent ?? "", scripts: root.querySelectorAll("script, iframe, object").length, handlers: [...root.querySelectorAll("*")].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length, printing: document.body.classList.contains("printing") };
    });
    await page.close();
    return summary;
  };

  const all = await printed("Docs/pages.pdf");
  expect(all).toMatchObject({ images: 12, printing: true });
  expect((await printed("Docs/pages.pdf", (p) => p.click("input[value=here]"))).images).toBe(1);
  expect((await printed("Docs/pages.pdf", async (p) => (await p.click("input[value=range]"), await p.fill(".print-range input >> nth=0", "3"), await p.fill(".print-range input >> nth=1", "5")))).images).toBe(3);
  expect((await printed("Docs/notes.txt")).text).toContain(NOTES_PHRASE);
  const hostile = await printed("Books/hostile.epub");
  expect(hostile).toMatchObject({ scripts: 0, handlers: 0 });
  expect(hostile.text).toContain("Chapter 4"); // the whole book
  expect((await printed("Books/hostile.epub", (p) => p.click("input[value=here]"))).text).not.toContain("Chapter 4");
  expect((await printed("Comics/strip.cbz")).images).toBe(3);
});

e2e("a share link opens one book for someone who is not signed in", async () => {
  const id = await bookId(ctx, inst, "Docs/notes.txt");
  const made = await api<{ token: string }>(ctx, inst, "/api/shares", { bookId: id, view: null, expiresInDays: 1 });
  const stranger = await browser.newContext();
  const page = await stranger.newPage();
  await page.goto(`${inst.url}/s/${made.token}`);
  await page.waitForSelector(".txt-body");
  expect(await page.textContent(".txt-body")).toContain(NOTES_PHRASE);
  expect(await page.$(".tree .node")).toBeNull(); // no library, only this book
  await stranger.close();
});

e2e("a PDF bookmark leads to the page that was on screen, and keeps an area only while that page is the one shown", async () => {
  const { page, errors } = await openBook("Docs/pages.pdf");
  await page.waitForSelector(".pdf-scroll .page canvas");
  const shown = () => page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value);
  const goTo = async (n: number) => {
    await page.fill(".pdf-page-input", String(n));
    await page.press(".pdf-page-input", "Enter");
    await page.waitForFunction((want) => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === String(want), n);
    await page.waitForTimeout(600); // the reader reports its view a moment after it stops
  };
  const bookmark = async () => {
    await page.click(".reader-bar button:has-text('★')");
    await page.click(".modal button[type=submit]");
    await page.waitForSelector(".modal .bookmark-go");
    await page.keyboard.press("Escape");
  };
  const open = async (index: number) => {
    await page.click(".reader-bar button:has-text('★')");
    await page.locator(".modal .bookmark-go").nth(index).click();
  };

  // an area drawn on page 3 ...
  await goTo(3);
  await page.click(".pdf-toolbar button:has-text('Area')");
  const box = (await page.locator(".pdf-scroll .page[data-page-number='3']").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector(".pdf-region:not(.pdf-region-draft)");
  await bookmark(); // the list is newest first: this ends up second, with its area

  // ... then another page, without any area of its own: the old area must not drag the bookmark back to page 3
  await goTo(9);
  await bookmark(); // ... and this one first
  await goTo(1);

  await open(0);
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "9");
  expect(await page.evaluate(() => decodeURIComponent(location.hash))).not.toContain("region");
  await goTo(1);
  await open(1);
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "3");
  await page.waitForSelector(".pdf-region:not(.pdf-region-draft)"); // the first bookmark still shows its area
  expect(await shown()).toBe("3");
  expect(errors).toEqual([]);
});

e2e("a PDF can be fitted whole and read in reading mode, which Esc and the toolbar both leave", async () => {
  const { page, errors } = await openBook("Docs/pages.pdf");
  await page.waitForSelector(".pdf-scroll .page canvas");
  const sizes = () =>
    page.evaluate(() => {
      const scroll = document.querySelector(".pdf-scroll") as HTMLElement;
      const first = (document.querySelector(".pdf-scroll .page") as HTMLElement).getBoundingClientRect();
      return { page: Math.round(first.height), window: scroll.clientHeight };
    });
  const visible = (selector: string) => page.evaluate((s) => !!document.querySelector(s) && (document.querySelector(s) as HTMLElement).offsetParent !== null, selector);

  // by width the first page is taller than the window; "Whole page" brings all of it into view
  expect((await sizes()).page).toBeGreaterThan((await sizes()).window);
  await page.click(".pdf-toolbar button:has-text('Whole page')");
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".pdf-scroll") as HTMLElement;
    return (document.querySelector(".pdf-scroll .page") as HTMLElement).getBoundingClientRect().height <= scroll.clientHeight;
  });

  // reading mode takes the panels away, keeps the toolbar, and the fitted page grows into the space
  const before = (await sizes()).window;
  await page.click(".pdf-toolbar button[aria-label='Reading mode']");
  expect(await visible(".topbar")).toBe(false);
  expect(await visible(".panel")).toBe(false);
  expect(await visible(".reader-bar")).toBe(false);
  expect(await visible(".pdf-toolbar")).toBe(true);
  await page.waitForFunction((was) => (document.querySelector(".pdf-scroll") as HTMLElement).clientHeight > was, before);
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".pdf-scroll") as HTMLElement;
    return Math.abs((document.querySelector(".pdf-scroll .page") as HTMLElement).getBoundingClientRect().height - scroll.clientHeight) < 80;
  });

  await page.keyboard.press("Escape");
  expect(await visible(".topbar")).toBe(true);
  expect(await visible(".reader-bar")).toBe(true);

  // the toolbar button leaves it too, and leaving the book never leaves the next screen bare
  await page.click(".pdf-toolbar button[aria-label='Reading mode']");
  expect(await visible(".topbar")).toBe(false);
  await page.click(".pdf-toolbar button[aria-label='Reading mode']");
  expect(await visible(".topbar")).toBe(true);
  await page.click(".pdf-toolbar button[aria-label='Reading mode']");
  await page.evaluate(() => (location.hash = ""));
  await page.waitForSelector(".shelf");
  expect(await visible(".topbar")).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
});
