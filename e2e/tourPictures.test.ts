import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { library } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let pdfId = "";

before(async () => {
  browser = await launch();
  inst = await startServer(library());
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst);
  pdfId = await bookId(ctx, inst, "Docs/pages.pdf");
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

/** Goes through the tour that is open: every step has a longer explanation and a picture, whose words fit in it and the card on the screen. */
async function everyStepExplained(page: Page, what: string): Promise<number> {
  const [, , total] = /(\d+)\D+(\d+)/.exec((await page.textContent(".tour-count"))!)!.map(Number) as [number, number, number];
  expect(total).toBeGreaterThan(2);
  const view = page.viewportSize()!;
  const problems: string[] = []; // all of them are told at the end, not only the first
  for (let step = 1; step <= total; step++) {
    const where = `${what}, step ${step} of ${total}`;
    await page.waitForSelector(".tour-toggle:not([hidden])", { timeout: 5000 }).catch(() => {
      throw new Error(`${where}: no "More" button`);
    });
    if (step === 1) await page.click(".tour-toggle"); // the next steps open with their details too
    await page.waitForSelector(".tour-more .tour-pic", { timeout: 5000 }).catch(() => {
      throw new Error(`${where}: no picture`);
    });
    const picture = (await page.locator(".tour-more .tour-pic").boundingBox())!;
    expect(picture.width, where).toBeGreaterThan(200);
    expect(picture.height, where).toBeGreaterThan(60);
    const paragraphs = await page.$$eval(".tour-more p", (ps) => ps.map((p) => p.textContent ?? ""));
    expect(paragraphs.join(" ").length, where).toBeGreaterThan(60);
    const outside = await page.evaluate(() => [...document.querySelectorAll<SVGTextElement>(".tour-pic text")].filter((node) => { const box = node.getBBox(); return box.x < 0 || box.x + box.width > 320; }).map((node) => node.textContent));
    problems.push(...outside.map((words) => `${where}: “${words}” does not fit the picture`));
    const card = (await page.locator(".tour-card").boundingBox())!;
    expect(card.x, where).toBeGreaterThanOrEqual(0);
    expect(card.y, where).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width, where).toBeLessThanOrEqual(view.width);
    expect(card.y + card.height, where).toBeLessThanOrEqual(view.height);
    await page.click(".tour-card .btn.primary");
  }
  expect(await page.$(".tour-card")).toBeNull();
  expect(problems).toEqual([]);
  return total;
}

for (const lang of ["en", "ru", "uk"] as const) {
  e2e(`every step of the three tours has a longer explanation with a picture that fits (${lang})`, async () => {
    // some books carry tags, so that the step about the tag bar is part of the tour
    await ctx.request.put(`${inst.url}/api/admin/books/${pdfId}/meta`, { data: { set: { tags: ["radio", "circuits"] } }, headers: { Origin: inst.url } });
    const made = await api(ctx, inst, "/api/projects", { title: `Tour ${lang}` });
    const add = (body: unknown) => api(ctx, inst, `/api/projects/${made.project.id}/items`, body);
    await add({ bookId: pdfId, view: { v: 1, page: 5 }, title: "Page five" });
    await add({ title: "A note" });

    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.addInitScript((l) => localStorage.setItem("lang", l), lang);
    await page.goto(inst.url + "/");
    await page.waitForSelector(".shelf");
    await page.selectOption("#lang", lang);

    // the whole interface
    await page.click("#tour");
    const library = await everyStepExplained(page, "library");
    expect(library).toBe(13); // the panel, the tree, search, the tag bar, the shelf bar, bookmarks, projects, links, edit, link, settings, theme and language

    // a book: its own tour (a PDF has the toolbar too)
    await page.goto(`${inst.url}/#book=${pdfId}&view=${encodeURIComponent(JSON.stringify({ v: 1, page: 2 }))}`);
    await page.waitForSelector(".pdf-scroll .page canvas");
    await page.waitForSelector("[data-tour=print]:not([hidden])");
    await page.click("#tour");
    expect(await everyStepExplained(page, "reader")).toBe(8);

    // a project
    await page.goto(inst.url + "/");
    await page.waitForSelector(".shelf");
    await page.click("[data-tour=projects]");
    await page.click(`.project-row:has-text('Tour ${lang}') .project-go`);
    await page.waitForSelector(".project-thumb canvas");
    await page.click(".project-help");
    expect(await everyStepExplained(page, "project")).toBe(8);
    expect(errors).toEqual([]);
    await page.close();
  });
}
