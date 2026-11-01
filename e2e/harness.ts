import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { removeDir } from "../src/server/testutil";

const TIMEOUT = 90_000; // a cold CI machine needs far more than bun's default 5 s for a browser step

/** `test` and `beforeAll` with room for a browser. (setDefaultTimeout from another module does not reach the test file.) */
export const e2e = (name: string, fn: () => Promise<void> | void) => test(name, fn, TIMEOUT);
export const before = (fn: () => Promise<void> | void) => beforeAll(fn, TIMEOUT);
export const after = (fn: () => Promise<void> | void) => afterAll(fn, TIMEOUT);

export const ADMIN = { name: "Alex", password: "secret1" };
const ROOT = resolve(import.meta.dir, "..");

export interface Instance {
  url: string;
  lib: string;
  data: string;
  stop(): Promise<void>;
}

/** Starts the real server (as `bun run dev` does) on a library made of `files`, on a free port. */
export async function startServer(files: Record<string, Uint8Array | string>, env: Record<string, string> = {}): Promise<Instance> {
  const base = mkdtempSync(join(tmpdir(), "tapalog-e2e-"));
  const lib = join(base, "library");
  const data = join(base, "data");
  mkdirSync(lib, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(lib, ...path.split("/").filter(Boolean));
    if (path.endsWith("/")) mkdirSync(full, { recursive: true }); // "Empty/" is an empty folder
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = Bun.spawn([process.execPath, "src/server/main.ts", "--library", lib, "--data", data, "--port", String(port), "--host", "127.0.0.1", "--no-open"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error("the server did not start")), 60_000);
    (async () => {
      const decoder = new TextDecoder();
      let seen = "";
      for await (const chunk of child.stdout) {
        seen += decoder.decode(chunk);
        const match = /Tapalog Reader\s+http:\/\/localhost:(\d+)\//.exec(seen);
        if (match) {
          clearTimeout(timer);
          return resolveUrl(`http://localhost:${match[1]}`);
        }
      }
      reject(new Error("the server exited: " + seen));
    })();
  });
  // drain the rest so a full pipe never stalls the server
  void (async () => void (await new Response(child.stderr).text()))();
  return {
    url,
    lib,
    data,
    async stop() {
      child.kill();
      await child.exited;
      removeDir(base);
    },
  };
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.E2E_CHROMIUM || undefined, args: ["--no-sandbox"] });
}

const origin = (url: string) => ({ Origin: url });

/** Creates the first administrator the way the first-run screen does. */
export async function setup(inst: Instance, account = ADMIN): Promise<void> {
  const res = await fetch(`${inst.url}/api/setup`, { method: "POST", headers: { "Content-Type": "application/json", ...origin(inst.url) }, body: JSON.stringify(account) });
  if (!res.ok) throw new Error(`setup failed: ${res.status}`);
}

/** A browser context already signed in as `account` (through the API, not the form). */
export async function signedIn(browser: Browser, inst: Instance, account = ADMIN, viewport = { width: 1200, height: 800 }, offerTour = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  if (!offerTour) await ctx.addInitScript(() => localStorage.setItem("tour", "1")); // the first-visit offer of the quick tour stays out of the way
  const res = await ctx.request.post(`${inst.url}/api/login`, { data: account, headers: origin(inst.url) });
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
  return ctx;
}

export async function api<T = any>(ctx: BrowserContext, inst: Instance, path: string, body?: unknown): Promise<T> {
  const res = body === undefined ? await ctx.request.get(inst.url + path) : await ctx.request.post(inst.url + path, { data: body, headers: origin(inst.url) });
  return (await res.json()) as T;
}

export async function bookId(ctx: BrowserContext, inst: Instance, path: string): Promise<string> {
  const lib = await api<{ books: { id: string; path: string }[] }>(ctx, inst, "/api/library");
  const found = lib.books.find((b) => b.path === path);
  if (!found) throw new Error("no such book: " + path);
  return found.id;
}

/**
 * foliate-js (the EPUB/FB2/MOBI engine) can lay a page out before its frame has a body and throw this one
 * error on a slow machine; the book still opens. Tests that open books leave it out.
 */
export const FOLIATE_RACE = /Cannot destructure property 'style'/;

/** Collects JavaScript errors of a page, so a test can say "and nothing broke". */
export function watchErrors(page: import("playwright-core").Page, ignore?: RegExp): string[] {
  const errors: string[] = [];
  const keep = (text: string) => !ignore?.test(text);
  page.on("pageerror", (e) => keep(e.message) && errors.push(e.message));
  // the CSP refusing a book's inline script is the protection working, and a 404 for an absent cover is normal
  page.on("console", (m) => m.type() === "error" && !/Content Security Policy|Failed to load resource/.test(m.text()) && keep(m.text()) && errors.push(m.text().slice(0, 200)));
  return errors;
}
