import { expect } from "bun:test";
import type { Browser, BrowserContext } from "playwright-core";
import { ADMIN, after, before, e2e, launch, signedIn, startServer, type Instance } from "./harness";

let browser: Browser;
let inst: Instance;
let ctx: BrowserContext;

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

e2e("the engine that reads pictures comes from the program itself and works under the page's own security policy, in Russian and in English", async () => {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(inst.url + "/");
  await page.waitForSelector(".credit-about", { state: "attached" });
  const read = await page.evaluate(async () => {
    await new Promise<void>((done, fail) => {
      const script = document.createElement("script");
      script.src = "/ocr/tesseract.min.js";
      script.onload = () => done();
      script.onerror = () => fail(new Error("no script"));
      document.head.append(script);
    });
    const Tesseract = (globalThis as unknown as { Tesseract: { createWorker(langs: string[], oem: number, options: object): Promise<{ recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }>; terminate(): Promise<void> }> } }).Tesseract;
    const draw = (text: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1400;
      canvas.height = 160;
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#fff";
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#000";
      g.font = "72px serif";
      g.fillText(text, 30, 105);
      return canvas;
    };
    const worker = await Tesseract.createWorker(["rus", "eng"], 1, {
      workerPath: `${location.origin}/ocr/worker.min.js`,
      corePath: `${location.origin}/ocr/core/tesseract-core-simd-lstm.wasm.js`,
      langPath: `${location.origin}/ocr/lang`,
      gzip: true,
      cacheMethod: "none",
    });
    const russian = (await worker.recognize(draw("Ламповый радиоприёмник"))).data.text;
    const english = (await worker.recognize(draw("Vacuum tube receiver"))).data.text;
    await worker.terminate();
    return { russian, english };
  });
  expect(read.russian.toLowerCase()).toMatch(/ламповый радиоприемник|ламповый радиоприёмник/);
  expect(read.english.toLowerCase()).toContain("vacuum tube receiver");
  expect(errors).toEqual([]);
  await page.close();
});
