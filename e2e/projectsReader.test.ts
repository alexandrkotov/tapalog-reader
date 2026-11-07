import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { library, NOTES_PHRASE } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, FOLIATE_RACE, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let pdfId = "";
let txtId = "";
let epubId = "";

before(async () => {
  browser = await launch();
  inst = await startServer(library());
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  pdfId = await bookId(ctx, inst, "Docs/pages.pdf");
  txtId = await bookId(ctx, inst, "Docs/notes.txt");
  epubId = await bookId(ctx, inst, "Books/story.epub");
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const open = async (context: BrowserContext, hash: string): Promise<{ page: Page; errors: string[] }> => {
  const page = await context.newPage();
  const errors = watchErrors(page, FOLIATE_RACE);
  await page.goto(`${inst.url}/${hash}`);
  return { page, errors };
};
const view = (id: string, v: unknown) => `#book=${id}&view=${encodeURIComponent(JSON.stringify(v))}`;
const projects = async () => (await api<{ projects: { id: number; title: string; items: number }[] }>(ctx, inst, "/api/projects")).projects;
const itemsOf = async (id: number) => (await api<{ items: { title: string; comment: string; quote: string; bookId: string | null; view: any }[] }>(ctx, inst, `/api/projects/${id}`)).items;

e2e("a place in a PDF is added to a new project and then to the same one again, and the reader stays where it was", async () => {
  const { page, errors } = await open(ctx, view(pdfId, { v: 1, page: 5 }));
  await page.waitForSelector(".pdf-scroll .page canvas");
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "5");

  await page.click("button[title='Add this place to a project']");
  await page.waitForSelector(".modal .project-edit");
  await page.waitForFunction(() => (document.querySelector(".modal select") as HTMLSelectElement | null)?.value === "new");
  expect(await page.inputValue(".modal input[placeholder='Title']")).toBe("Page 5"); // the name the reader suggests
  expect(await page.$(".modal textarea[placeholder='Quote']")).toBeNull(); // a PDF has no passage
  await page.fill(".modal input[placeholder='Name of a new project']", "My amplifier");
  await page.fill(".modal textarea[placeholder='Comment']", "the output stage");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector(".modal .project-added");
  expect(await page.textContent(".modal .project-added")).toBe("Added to “My amplifier”.");

  const [project] = await projects();
  expect(project).toMatchObject({ title: "My amplifier", items: 1 });
  expect((await itemsOf(project!.id))[0]).toMatchObject({ title: "Page 5", comment: "the output stage", bookId: pdfId, view: { v: 1, page: 5 }, quote: "" });

  await page.click(".modal button:has-text('Close')");
  expect(await page.$(".modal")).toBeNull();
  expect(await page.evaluate(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value)).toBe("5"); // nothing moved

  // the next time the same project is offered, and the new one is a choice
  await page.fill(".pdf-page-input", "8");
  await page.press(".pdf-page-input", "Enter");
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "8");
  await page.click("button[title='Add this place to a project']");
  await page.waitForFunction(() => document.querySelectorAll(".modal select option").length === 2); // options are never "visible" to the browser driver
  expect(await page.$$eval(".modal select option", (o) => o.map((x) => x.textContent))).toEqual(["My amplifier", "New project…"]);
  expect(await page.$eval(".modal select", (s) => (s as HTMLSelectElement).value)).toBe(String(project!.id));
  expect(await page.$eval(".modal input[placeholder='Name of a new project']", (i) => (i as HTMLElement).hidden)).toBe(true);
  await page.fill(".modal input[placeholder='Title']", "Power supply");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector(".modal .project-added");
  await page.click(".modal button:has-text('Open the project')");
  await page.waitForSelector(".project-item");
  expect(await page.$$eval(".project-item .project-go", (e) => e.map((x) => x.textContent))).toEqual(["Page 5", "Power supply"]);
  await page.click(".project-item:first-child button.project-go"); // back to page 5
  await page.waitForFunction(() => (document.querySelector(".pdf-page-input") as HTMLInputElement).value === "5");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a passage selected in a text book is added with its words and opens marked", async () => {
  const { page, errors } = await open(ctx, `#book=${txtId}`);
  await page.waitForSelector(".txt-body");
  await page.evaluate((phrase) => {
    const walker = document.createTreeWalker(document.querySelector(".txt-body")!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(phrase);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + phrase.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return;
      }
    }
    throw new Error("phrase not found");
  }, NOTES_PHRASE);
  await page.click("button[title='Add this place to a project']");
  await page.waitForSelector(".modal textarea[placeholder='Quote']");
  expect(await page.inputValue(".modal textarea[placeholder='Quote']")).toBe(NOTES_PHRASE);
  await page.waitForFunction(() => (document.querySelector(".modal select") as HTMLSelectElement | null)?.value !== "");
  await page.fill(".modal input[placeholder='Title']", "The harbour");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector(".modal .project-added");
  await page.close();

  const list = await projects();
  const project = list.find((p) => p.title === "My amplifier")!; // the one used last
  const item = (await itemsOf(project.id)).find((i) => i.title === "The harbour")!;
  expect(item.quote).toBe(NOTES_PHRASE);
  expect(item.view.range).toHaveLength(2);
  expect(item.view.range[1] - item.view.range[0]).toBe(NOTES_PHRASE.length);

  const again = await open(ctx, "");
  await again.page.click("button:has-text('My projects')");
  await again.page.click(".project-row .project-go");
  await again.page.waitForSelector(".project-item");
  await again.page.click(".project-item:last-child button.project-go");
  await again.page.waitForSelector(".txt-body mark");
  expect(await again.page.textContent(".txt-body mark")).toBe(NOTES_PHRASE);
  expect(errors).toEqual([]);
  await again.page.close();
});

e2e("several passages of one book go to one project as separate items, each opening marked with its own words", async () => {
  const { page, errors } = await open(ctx, `#book=${txtId}`);
  await page.waitForSelector(".txt-body");
  const select = (from: number) =>
    page.evaluate((start) => {
      const node = document.createTreeWalker(document.querySelector(".txt-body")!, NodeFilter.SHOW_TEXT).nextNode()!; // the whole text is one node
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 30);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      return range.toString();
    }, from);
  const addSelected = async (title: string) => {
    await page.click("button[title='Add this place to a project']");
    await page.waitForSelector(".modal textarea[placeholder='Quote']");
    await page.waitForFunction(() => (document.querySelector(".modal select") as HTMLSelectElement | null)?.value !== "");
    await page.fill(".modal input[placeholder='Title']", title);
    await page.click(".modal button[type=submit]");
    await page.waitForSelector(".modal .project-added");
    await page.click(".modal button:has-text('Close')");
  };
  const first = await select(300);
  await addSelected("First passage");
  const second = await select(1500);
  expect(second).not.toBe(first);
  await addSelected("Second passage");
  await page.close();

  const project = (await projects()).find((p) => p.title === "My amplifier")!;
  const items = await itemsOf(project.id);
  const one = items.find((i) => i.title === "First passage")!;
  const two = items.find((i) => i.title === "Second passage")!;
  const flat = (text: string) => text.replace(/\s+/g, " ").trim(); // the quote is kept on one line
  expect(one.quote).toBe(flat(first));
  expect(two.quote).toBe(flat(second));
  expect(one.view.range).not.toEqual(two.view.range);

  const again = await open(ctx, "");
  await again.page.click("button:has-text('My projects')");
  await again.page.click(".project-row .project-go");
  await again.page.waitForSelector(".project-item");
  const titles = await again.page.$$eval(".project-item .project-go", (e) => e.map((x) => x.textContent));
  await again.page.click(`.project-item:nth-child(${titles.indexOf("Second passage") + 1}) button.project-go`);
  await again.page.waitForSelector(".txt-body mark");
  expect(await again.page.textContent(".txt-body mark")).toBe(second); // the second one, not the first
  expect(errors).toEqual([]);
  await again.page.close();
});

e2e("a passage selected in an EPUB is added with its words and the place of the words", async () => {
  const { page, errors } = await open(ctx, `#book=${epubId}`);
  await page.waitForFunction(() => /%/.test(document.querySelector(".book-progress")?.textContent ?? ""));
  let quote = "";
  for (let i = 0; i < 40 && !quote; i++) {
    for (const frame of page.frames().filter((f) => f !== page.mainFrame())) {
      quote = await frame
        .evaluate(() => {
          const p = document.querySelector("p");
          if (!p?.firstChild) return "";
          const range = document.createRange();
          range.setStart(p.firstChild, 0);
          range.setEnd(p.firstChild, Math.min(24, (p.firstChild.textContent ?? "").length));
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
          return range.toString();
        })
        .catch(() => "");
      if (quote) break;
    }
    if (!quote) await Bun.sleep(250);
  }
  expect(quote.length).toBeGreaterThan(5);
  await page.click("button[title='Add this place to a project']");
  await page.waitForSelector(".modal textarea[placeholder='Quote']");
  expect(await page.inputValue(".modal textarea[placeholder='Quote']")).toBe(quote);
  await page.waitForFunction(() => (document.querySelector(".modal select") as HTMLSelectElement | null)?.value !== "");
  await page.fill(".modal input[placeholder='Title']", "From the story");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector(".modal .project-added");
  await page.close();

  const project = (await projects()).find((p) => p.title === "My amplifier")!;
  const item = (await itemsOf(project.id)).find((i) => i.title === "From the story")!;
  expect(item.bookId).toBe(epubId);
  expect(item.quote).toBe(quote);
  expect(typeof item.view.cfi).toBe("string");
  expect(typeof item.view.range).toBe("string"); // where the words are, not only the page
  expect(errors).toEqual([]);
});

e2e("an EPUB place is added too, and an anonymous visitor is asked to sign in first", async () => {
  const { page, errors } = await open(ctx, `#book=${epubId}`);
  await page.waitForFunction(() => /%/.test(document.querySelector(".book-progress")?.textContent ?? ""));
  await page.click("button[title='Add this place to a project']");
  await page.waitForSelector(".modal .project-edit");
  await page.waitForFunction(() => (document.querySelector(".modal select") as HTMLSelectElement | null)?.value !== "");
  expect(await page.$(".modal textarea[placeholder='Quote']")).toBeNull(); // nothing selected, nothing marked
  await page.fill(".modal input[placeholder='Title']", "Chapter start");
  await page.click(".modal button[type=submit]");
  await page.waitForSelector(".modal .project-added");
  await page.close();
  const [project] = await projects();
  const item = (await itemsOf(project!.id)).find((i) => i.title === "Chapter start")!;
  expect(item.bookId).toBe(epubId);
  expect(typeof item.view.cfi).toBe("string");

  const guest = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await guest.addInitScript(() => localStorage.setItem("tour", "1"));
  const seen = await open(guest, `#book=${txtId}`);
  await seen.page.waitForSelector(".txt-body");
  await seen.page.click("button[title='Add this place to a project']");
  await seen.page.waitForSelector(".modal");
  expect(await seen.page.textContent(".modal")).toContain("Sign in or create an account to keep projects");
  expect(await seen.page.$(".modal .project-edit")).toBeNull();
  await guest.close();
  expect(errors).toEqual([]);
});
