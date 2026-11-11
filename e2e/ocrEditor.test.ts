import { expect } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PAGE_H, PAGE_W, scanPdf, scanPictures } from "./fixtures";
import { ADMIN, after, api, before, bookId, e2e, launch, signedIn, startServer, watchErrors, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;
let id = "";

before(async () => {
  browser = await launch();
  const [picture] = await scanPictures(browser, [["Ламповый радиоприёмник", "для начинающих радиолюбителей"]]);
  inst = await startServer({ "Scans/edit.pdf": scanPdf([picture!, picture!, picture!], PAGE_W, PAGE_H) });
  await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: inst.url }, body: JSON.stringify(ADMIN) });
  ctx = await signedIn(browser, inst, ADMIN, { width: 1300, height: 800 }, false, true); // the visual editor, as a reader meets it
  await api(ctx, inst, "/api/admin/fulltext", { enabled: true });
  id = await bookId(ctx, inst, "Scans/edit.pdf");
  await api(ctx, inst, `/api/admin/ocr/${id}/start`, { pages: 3, lang: "rus" });
  // page 1 is as the recognizer left it, page 2 was typed by a person (its lines are kept), page 3 is not read
  await ctx.request.put(`${inst.url}/api/admin/ocr/${id}/pages/1`, { data: { text: "Ламповый радиоприёмник\n\nЦена $5 и $6. Формула $E=mc^2$.\n\n**жирный** и 3 * 4" }, headers: { Origin: inst.url } });
  await ctx.request.put(`${inst.url}/api/admin/ocr/${id}/edit/2`, { data: { text: "строка один\nстрока два" }, headers: { Origin: inst.url } });
});
after(async () => {
  await browser?.close();
  await inst?.stop();
});

const editor = (n: number) => `.proof-row:nth-child(${n}) .proof-editor .ProseMirror`;
const textarea = (n: number) => `.proof-row:nth-child(${n}) .proof-text`;

async function openProof(page: Page): Promise<void> {
  await page.goto(inst.url + "/");
  await page.evaluate(() => localStorage.removeItem("tapalog.proofEditor")); // the visual editor, whatever an earlier test chose
  await page.waitForSelector(".credit-about", { state: "attached" });
  await page.click("button:has-text('Settings')");
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForSelector(".ocr-row");
  await page.click(".ocr-row .ocr-proof");
  await page.waitForFunction(() => document.querySelectorAll(".proof-row").length === 3);
  await page.waitForSelector(editor(1));
}

/** Puts the cursor into the text where a click lands; the editor takes the new selection a moment after the click. */
async function clickInto(page: Page, selector: string): Promise<void> {
  await page.click(selector);
  await page.waitForTimeout(150);
}

/** What the server holds of a page. */
async function held(n: number): Promise<string | undefined> {
  const list = (await (await ctx.request.get(`${inst.url}/api/admin/ocr/${id}/pages`)).json()) as { items: { page: number; text: string }[] };
  return list.items.find((i) => i.page === n)?.text;
}
const heldIs = (n: number, text: string) => async () => {
  for (let i = 0; i < 60; i++) {
    if ((await held(n)) === text) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(await held(n)).toBe(text);
};

e2e("the text of a page is shown as it will read, with bold and formulas drawn, prices left alone, and nothing is saved until it is changed", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  const puts: string[] = [];
  page.on("request", (r) => r.method() === "PUT" && r.url().includes("/ocr/") && puts.push(r.url())); // what is sent for a page
  await openProof(page);
  expect(await page.isVisible(textarea(1))).toBe(false); // the plain text is behind the editor
  expect(await page.textContent(`${editor(1)} strong`)).toBe("жирный");
  await page.waitForSelector(`${editor(1)} .katex`);
  expect(await page.locator(`${editor(1)} .katex`).count()).toBe(1); // the formula only: the two prices are text
  expect(await page.textContent(`${editor(1)} p:nth-child(2)`)).toContain("Цена $5 и $6.");
  // the lines a person typed stay lines
  const lines = await page.$eval(`${editor(2)} p`, (p) => p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight));
  expect(lines).toBeGreaterThan(1.8);
  // an unread page says so
  await page.waitForSelector(".proof-row:nth-child(3) .proof-editor.empty");
  expect(await page.getAttribute(".proof-row:nth-child(3) .proof-editor", "data-placeholder")).not.toBe("");

  // clicking into the text and away saves nothing: the page is as the recognizer left it
  await page.click(`${editor(1)} p`);
  await page.click(`${editor(2)} p`);
  await page.waitForTimeout(1500);
  expect(puts).toEqual([]);
  expect((await ctx.request.get(`${inst.url}/api/admin/ocr/${id}/pages`).then((r) => r.json())).edited).toBe(1); // page 2 only, as before
  expect(errors).toEqual([]);
  await page.close();
});

e2e("what is typed in the editor is saved as plain lines, with the signs it protected given back", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  await clickInto(page, `${editor(1)} p:nth-child(3)`);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" дописано");
  await heldIs(1, "Ламповый радиоприёмник\n\nЦена $5 и $6. Формула $E=mc^2$.\n\n**жирный** и 3 * 4 дописано")();
  expect(await page.isVisible(".proof-row:nth-child(1) .proof-badge")).toBe(true);
  expect(await page.inputValue(textarea(1))).toBe("Ламповый радиоприёмник\n\nЦена $5 и $6. Формула $E=mc^2$.\n\n**жирный** и 3 * 4 дописано");

  // Shift+Enter is a line break of this text, not a backslash at the end of a line
  await clickInto(page, `${editor(2)} p`);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("строка три");
  await heldIs(2, "строка один\nстрока два\nстрока три")();

  // Enter starts a paragraph, a heading is made as in Markdown
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Итог");
  await heldIs(2, "строка один\nстрока два\nстрока три\n\n## Итог")();
  expect(await page.textContent(`${editor(2)} h2`)).toBe("Итог");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("the plain text and the visual editor show one text: what is typed in one is there in the other, and the choice is remembered", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  expect(await page.getAttribute(".proof-source", "title")).toContain("plain text");
  expect(await page.getAttribute(".proof-source", "aria-pressed")).toBe("false");
  await page.click(".proof-source");
  expect(await page.getAttribute(".proof-source", "aria-pressed")).toBe("true");
  expect(await page.isVisible(textarea(3))).toBe(true);
  expect(await page.isVisible(editor(3))).toBe(false);
  expect(await page.inputValue(textarea(2))).toBe("строка один\nстрока два\nстрока три\n\n## Итог");
  await page.fill(textarea(3), "**третья** страница");
  await heldIs(3, "**третья** страница")();

  // back to the visual editor: the text typed there is shown as it reads
  await page.click(".proof-source");
  await page.waitForSelector(`${editor(3)} strong`);
  expect(await page.textContent(`${editor(3)} strong`)).toBe("третья");

  // the choice of the plain text is kept for the next time the window is opened
  await page.click(".proof-source");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal.proof", { state: "detached" });
  await openProofAgain(page);
  expect(await page.isVisible(textarea(3))).toBe(true);
  await page.click(".proof-source"); // visual again for the other tests
  expect(errors).toEqual([]);
  await page.close();
});

async function openProofAgain(page: Page): Promise<void> {
  await page.click("button:has-text('Settings')"); // Esc closed the settings with the window
  await page.waitForSelector(".modal .section");
  await page.click("button:has-text('Recognize scanned pages')");
  await page.waitForSelector(".ocr-row");
  await page.click(".ocr-row .ocr-proof");
  await page.waitForFunction(() => document.querySelectorAll(".proof-row").length === 3);
}

e2e("a figure put into a page is shown in the editor, and a page taken back shows the text the recognizer read", async () => {
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await openProof(page);
  await page.click(".proof-row:nth-child(1) .proof-whole");
  await page.waitForSelector(`${editor(1)} img[src*="images/"]`);
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLImageElement).naturalWidth > 0, `${editor(1)} img[src*="images/"]`); // the picture is found where the server keeps it
  expect(await page.inputValue(textarea(1))).toContain("![Fig. 1.1](images/p001-1.png)");
  await heldIs(1, await page.inputValue(textarea(1)))();

  // page 1 was typed in a test before: taking it back gives what the recognizer read, in the editor too
  await page.click(".proof-row:nth-child(1) .proof-restore");
  await page.waitForFunction(() => !document.querySelector(".proof-row:nth-child(1) .proof-badge:not([hidden])"));
  expect(await page.inputValue(textarea(1))).toBe("Ламповый радиоприёмник\n\nЦена $5 и $6. Формула $E=mc^2$.\n\n**жирный** и 3 * 4");
  await page.waitForFunction((sel) => !document.querySelector(sel + ' img[src*="images/"]') && document.querySelectorAll(sel + " strong").length === 1, editor(1));
  expect(errors).toEqual([]);
  await page.close();
});

/** Gives a page the text a person typed (its lines are kept). */
async function seed(n: number, text: string): Promise<void> {
  await ctx.request.put(`${inst.url}/api/admin/ocr/${id}/edit/${n}`, { data: { text }, headers: { Origin: inst.url } });
}

e2e("the tools above the text format the paragraph the cursor is in, and are off in the plain text and until a text is entered", async () => {
  await seed(3, "Первая строка\n\nВторая строка\n\nТретья строка");
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  expect(await page.isVisible(".proof-tools")).toBe(true);
  expect(await page.isDisabled(".proof-tool-bold")).toBe(true); // no cursor in any text yet
  expect(await page.getAttribute(".proof-tool-bold", "title")).toBe("Bold (Ctrl+B)");
  await page.$eval(".proof-pages", (s) => (s.scrollTop = s.scrollHeight));
  await page.waitForSelector(editor(3));

  await page.click(`${editor(3)} p:nth-child(1)`, { clickCount: 3 }); // the whole paragraph
  expect(await page.isDisabled(".proof-tool-bold")).toBe(false);
  await page.click(".proof-tool-bold");
  await heldIs(3, "**Первая строка**\n\nВторая строка\n\nТретья строка")();
  expect(await page.evaluate(() => !!document.activeElement?.closest(".proof-editor"))).toBe(true); // the cursor stayed in the text

  await page.click(`${editor(3)} p:nth-child(2)`, { clickCount: 3 });
  await page.click(".proof-tool-italic");
  await page.click(`${editor(3)} p:nth-child(3)`);
  await page.click(".proof-tool-heading");
  await heldIs(3, "**Первая строка**\n\n*Вторая строка*\n\n### Третья строка")();
  await page.click(".proof-tool-heading"); // again: a paragraph
  await heldIs(3, "**Первая строка**\n\n*Вторая строка*\n\nТретья строка")();

  await page.click(".proof-tool-bullet");
  await heldIs(3, "**Первая строка**\n\n*Вторая строка*\n\n* Третья строка")();
  await page.click(".proof-tool-bullet"); // the same button again does not undo it; the list stays a list
  await page.click(`${editor(3)} p`, { clickCount: 3 });

  // in the plain text there are no tools
  await page.click(".proof-source");
  expect(await page.isVisible(".proof-tools")).toBe(false);
  await page.click(".proof-source");
  expect(await page.isVisible(".proof-tools")).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
});

e2e("undo and redo take back one change at a time, as Ctrl+Z does, and the button that throws away every change says so", async () => {
  const start = "Первая строка\n\nВторая строка\n\nТретья строка";
  await seed(3, start);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  await page.$eval(".proof-pages", (s) => (s.scrollTop = s.scrollHeight));
  await page.waitForSelector(editor(3));
  expect(await page.getAttribute(".proof-tool-undo", "title")).toBe("Undo the last change (Ctrl+Z)");
  expect(await page.getAttribute(".proof-tool-redo", "title")).toBe("Redo (Ctrl+Shift+Z)");
  expect(await page.isDisabled(".proof-tool-undo")).toBe(true); // no cursor in any text yet

  await clickInto(page, `${editor(3)} p:nth-child(3)`);
  await page.keyboard.press("End");
  await page.keyboard.type(" А");
  await page.waitForTimeout(800); // a pause makes the next change a step of its own
  await clickInto(page, `${editor(3)} p:nth-child(1)`);
  await page.keyboard.press("End");
  await page.keyboard.type(" Б");
  await heldIs(3, "Первая строка Б\n\nВторая строка\n\nТретья строка А")();

  await page.click(".proof-tool-undo"); // the last change only
  await heldIs(3, "Первая строка\n\nВторая строка\n\nТретья строка А")();
  expect(await page.inputValue(textarea(3))).toBe("Первая строка\n\nВторая строка\n\nТретья строка А");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".proof-editor"))).toBe(true); // the cursor stays in the text
  await page.click(".proof-tool-undo");
  await heldIs(3, start)();
  await page.click(".proof-tool-redo");
  await heldIs(3, "Первая строка\n\nВторая строка\n\nТретья строка А")();
  await page.keyboard.press("Control+z"); // the keys do the same
  await heldIs(3, start)();

  // the button that throws all of it away is not an undo, and its name and hint say what it does
  const reset = ".proof-row:nth-child(3) .proof-restore";
  await page.click(`${editor(3)} p:nth-child(3)`);
  await page.keyboard.type("!");
  await page.waitForSelector(`${reset}:not([hidden])`);
  expect(await page.textContent(reset)).toBe("Reset to recognized");
  expect(await page.getAttribute(reset, "title")).toContain("Ctrl+Z");
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.click(reset);
  await page.waitForTimeout(300);
  expect(asked).toContain("All your changes to this page will be lost");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("the tools stand over the column of the text, not over the scan, in the usual view, with the page whole, and on a narrow screen", async () => {
  await seed(3, "Первая строка");
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  const box = (sel: string) => page.$eval(sel, (e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top };
  });
  const over = async () => {
    const tools = await box(".proof-tools");
    const side = await box(".proof-row:nth-child(1) .proof-side");
    const scan = await box(".proof-row:nth-child(1) .proof-scan");
    expect(Math.abs(tools.left - side.left)).toBeLessThan(2); // the left edge of the text column
    expect(tools.left).toBeGreaterThanOrEqual(scan.right); // never over the scan
    expect(tools.top).toBeLessThan(side.top);
  };
  await over();
  await page.click(".proof-fit");
  await page.waitForSelector(".proof-pages.fit");
  await over();
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForTimeout(300);
  const tools = await box(".proof-tools");
  const pages = await box(".proof-pages");
  expect(Math.abs(tools.left - pages.left)).toBeLessThan(6); // one column: the tools are at the left, over both
  expect(errors).toEqual([]);
  await page.close();
});

e2e("a formula is put in with a window that shows it as it is typed, edited by a click on it, and taken out; Esc leaves only that window", async () => {
  await seed(3, "Перед формулой.");
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await openProof(page);
  await page.$eval(".proof-pages", (s) => (s.scrollTop = s.scrollHeight));
  await page.waitForSelector(editor(3));
  await clickInto(page, `${editor(3)} p`);
  await page.keyboard.press("Control+End");

  await page.click(".proof-tool-formula");
  await page.waitForSelector(".modal.formula");
  expect(await page.getAttribute(".modal.formula .formula-latex", "aria-label")).toBe("Formula in LaTeX");
  await page.fill(".formula-latex", "x^2 + y^2");
  await page.waitForSelector(".formula-preview .katex");
  // a piece of LaTeX goes in at the cursor
  await page.click(".formula-pieces button:has-text('√')");
  expect(await page.inputValue(".formula-latex")).toBe("x^2 + y^2\\sqrt{}");
  await page.keyboard.type("z");
  expect(await page.inputValue(".formula-latex")).toBe("x^2 + y^2\\sqrt{z}");
  // Esc closes the window of the formula only
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal.formula", { state: "detached" });
  expect(await page.isVisible(".modal.proof")).toBe(true);
  expect(await page.locator(`${editor(3)} .katex`).count()).toBe(0);

  await page.click(".proof-tool-formula");
  await page.fill(".formula-latex", "x^2 + y^2");
  await page.click(".modal.formula button:has-text('Insert')");
  await page.waitForSelector(`${editor(3)} .katex`);
  await heldIs(3, "Перед формулой.$x^2 + y^2$")();

  // a click on the formula opens it with its text; applying changes it in the text
  await page.click(`${editor(3)} [data-type='math_inline']`);
  await page.waitForSelector(".modal.formula");
  expect(await page.inputValue(".formula-latex")).toBe("x^2 + y^2");
  expect(await page.isVisible(".modal.formula button:has-text('Delete')")).toBe(true);
  await page.fill(".formula-latex", "a_1");
  await page.click(".modal.formula button:has-text('Apply')");
  await heldIs(3, "Перед формулой.$a_1$")();

  // a formula on a line of its own
  await page.click(`${editor(3)} p`);
  await page.keyboard.press("Control+End");
  await page.click(".proof-tool-formula-block");
  await page.fill(".formula-latex", "\\frac{1}{2}");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(`${editor(3)} [data-type='math_block'] .katex`);
  expect(await page.inputValue(textarea(3))).toContain("$$\n\\frac{1}{2}\n$$");

  // and taken out
  await page.click(`${editor(3)} [data-type='math_block']`);
  await page.waitForSelector(".modal.formula");
  await page.click(".modal.formula button:has-text('Delete')");
  await page.waitForFunction((sel) => !document.querySelector(sel + " [data-type='math_block']"), editor(3));
  expect(await page.inputValue(textarea(3))).not.toContain("$$");
  expect(errors).toEqual([]);
  await page.close();
});

e2e("the editor is made only for the pages near the window, and a page left far behind lets it go with its text kept", async () => {
  const [picture] = await scanPictures(browser, [["Страница", "из длинной книги"]]);
  const own = await startServer({ "Scans/long.pdf": scanPdf(Array.from({ length: 40 }, () => picture!), PAGE_W, PAGE_H) });
  try {
    await fetch(`${own.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: own.url }, body: JSON.stringify(ADMIN) });
    const mine = await signedIn(browser, own, ADMIN, { width: 1300, height: 800 }, false, true);
    await api(mine, own, "/api/admin/fulltext", { enabled: true });
    const longId = await bookId(mine, own, "Scans/long.pdf");
    await api(mine, own, `/api/admin/ocr/${longId}/start`, { pages: 40, lang: "rus" });
    await mine.request.put(`${own.url}/api/admin/ocr/${longId}/edit/1`, { data: { text: "первая страница" }, headers: { Origin: own.url } });
    const page = await mine.newPage();
    await page.goto(own.url + "/");
    await page.waitForSelector(".credit-about", { state: "attached" });
    await page.click("button:has-text('Settings')");
    await page.click("button:has-text('Recognize scanned pages')");
    await page.click(".ocr-row .ocr-proof");
    await page.waitForFunction(() => document.querySelectorAll(".proof-row").length === 40);
    await page.waitForSelector(editor(1));
    const made = () => page.locator(".proof-editor .ProseMirror").count();
    expect(await made()).toBeGreaterThan(0);
    expect(await made()).toBeLessThan(20); // not one for each of the forty pages
    await page.click(`${editor(1)} p`);
    await page.keyboard.type(" и ещё");
    await page.$eval(".proof-pages", (s) => (s.scrollTop = s.scrollHeight));
    await page.waitForSelector(editor(40));
    await page.waitForFunction((sel) => !document.querySelector(sel), editor(1)); // the first page is far away now
    expect(await made()).toBeLessThan(20);
    // what was typed there is in the textarea, and back at the top the editor shows it
    expect(await page.inputValue(textarea(1))).toBe("первая страница и ещё");
    await page.$eval(".proof-pages", (s) => (s.scrollTop = 0));
    await page.waitForSelector(editor(1));
    expect(await page.textContent(`${editor(1)} p`)).toBe("первая страница и ещё");
    await page.close();
    await mine.close();
  } finally {
    await own.stop();
  }
});
