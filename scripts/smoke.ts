/**
 * Starts a compiled executable on an empty library with one book and checks that it serves what a
 * browser needs: the page, the pdf.js files embedded in the binary, the library API and the book.
 * Used by CI after building; works on Linux, macOS and Windows.
 *
 * Usage: bun scripts/smoke.ts <path to the executable>
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = process.argv[2];
if (!exe) {
  console.error("Usage: bun scripts/smoke.ts <executable>");
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), "tapalog-smoke-"));
const library = join(base, "books");
const data = join(base, "data");
mkdirSync(library);
mkdirSync(data);
writeFileSync(join(library, "hello.txt"), "hello from the smoke test");

const port = 20000 + Math.floor(Math.random() * 20000);
const child = Bun.spawn([resolve(exe), "--library", library, "--data", data, "--port", String(port), "--host", "127.0.0.1", "--no-open"], { stdout: "pipe", stderr: "pipe" });
const root = `http://127.0.0.1:${port}`;

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

async function waitFor<T>(what: string, get: () => Promise<T | null>, ms = 60_000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await get();
      if (value) return value;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  console.log(`FAIL timed out waiting for ${what}`);
  failed = true;
  return null;
}

try {
  const library_ = await waitFor("a library with one book", async () => {
    const res = await fetch(`${root}/api/library`);
    const data = (await res.json()) as { books?: { id: string; name: string }[] };
    return data.books?.length === 1 ? data.books : null;
  });
  if (library_) {
    check(library_[0]!.name === "hello", "the book is scanned");
    const page = await fetch(`${root}/`);
    check(page.ok && (await page.text()).includes("<script"), "the page is served");
    for (const asset of ["pdf.worker.min.mjs", "wasm/openjpeg.wasm"]) {
      const res = await fetch(`${root}/pdfjs/${asset}`);
      check(res.ok && (await res.arrayBuffer()).byteLength > 1000, `/pdfjs/${asset} is embedded`);
    }
    for (const asset of ["tesseract.min.js", "worker.min.js", "core/tesseract-core-simd-lstm.wasm.js", "lang/rus.traineddata.gz", "lang/eng.traineddata.gz"]) {
      const res = await fetch(`${root}/ocr/${asset}`);
      check(res.ok && (await res.arrayBuffer()).byteLength > 10_000, `/ocr/${asset} is embedded`);
    }
    for (const asset of ["pdf-lib.min.js", "fontkit.umd.min.js"]) {
      const res = await fetch(`${root}/pdflib/${asset}`);
      check(res.ok && (await res.arrayBuffer()).byteLength > 400_000, `/pdflib/${asset} is embedded`);
    }
    const bridge = await fetch(`${root}/plugin-host/bridge.js`);
    check(bridge.ok && (await bridge.text()).includes("need-file"), "/plugin-host/bridge.js (the script of isolated plugins) is embedded");
    const book = await fetch(`${root}/api/file/${library_[0]!.id}`);
    check((await book.text()) === "hello from the smoke test", "the book file is served");
    const status = (await (await fetch(`${root}/api/status`)).json()) as { writable?: boolean };
    check(status.writable === true, "the library is writable (edit mode would work)");
  }
} finally {
  child.kill();
  await child.exited;
  rmSync(base, { recursive: true, force: true });
}

if (failed) {
  console.log("--- server output ---");
  console.log(await new Response(child.stdout).text(), await new Response(child.stderr).text());
  process.exit(1);
}
console.log("smoke test passed");
