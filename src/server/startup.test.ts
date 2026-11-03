import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeDir } from "./testutil";

const base = mkdtempSync(join(tmpdir(), "reader-startup-"));
afterAll(() => removeDir(base));

/** Starts the program (from source) and returns what it printed first, then stops it. */
async function startAndRead(args: string[], env: Record<string, string> = {}): Promise<{ out: string; exit: number | null }> {
  const lib = join(base, "lib");
  mkdirSync(lib, { recursive: true });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "main.ts"), "--library", lib, "--data", join(base, "data"), "--host", "127.0.0.1", "--no-open", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  let out = "";
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !/Data folder/.test(out)) {
    const next = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
    if (next === null) {
      if (child.exitCode !== null) break;
      continue;
    }
    if (next.done) break;
    out += new TextDecoder().decode(next.value);
  }
  child.kill();
  await child.exited;
  return { out, exit: child.exitCode };
}

test("when the usual ports are not available and none was asked for, the system picks a free one", async () => {
  // 8920-8939 held here (a port that is already taken by something else stays as it is: the effect is the same)
  const holders: ReturnType<typeof Bun.serve>[] = [];
  for (let port = 8920; port < 8940; port++) {
    try {
      holders.push(Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("busy") }));
    } catch {
      /* in use already */
    }
  }
  try {
    const { out } = await startAndRead([], { PORT: "" });
    const port = Number(/Tapalog Reader\s+http:\/\/localhost:(\d+)\//.exec(out)?.[1]);
    expect(port).toBeGreaterThan(0);
    expect(port >= 8920 && port < 8940).toBe(false);
    expect(out).toContain("are not available on this computer");
  } finally {
    for (const h of holders) h.stop(true);
  }
}, 30_000);

test("a port that was asked for and is not free is an error, not a quiet change", async () => {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
  try {
    const taken = holder.port;
    // every port from the asked one to 19 more is held, so there is nothing to fall back to
    const more: ReturnType<typeof Bun.serve>[] = [];
    for (let p = taken! + 1; p < taken! + 20; p++) {
      try {
        more.push(Bun.serve({ hostname: "127.0.0.1", port: p, fetch: () => new Response("busy") }));
      } catch {
        /* in use already */
      }
    }
    const { out, exit } = await startAndRead(["--port", String(taken)]);
    expect(out).not.toContain("Data folder");
    expect(exit).not.toBe(0);
    for (const h of more) h.stop(true);
  } finally {
    holder.stop(true);
  }
}, 30_000);

/** Starts the program with its own data folder and waits until it listens; the caller stops it. */
async function startKept(data: string): Promise<{ child: ReturnType<typeof Bun.spawn>; port: number }> {
  const lib = join(base, "lib");
  mkdirSync(lib, { recursive: true });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const free = probe.port;
  probe.stop(true);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "main.ts"), "--library", lib, "--data", data, "--host", "127.0.0.1", "--no-open", "--port", String(free)], { stdout: "pipe", stderr: "pipe" });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !/Data folder/.test(out)) {
    const next = await Promise.race([reader.read(), Bun.sleep(500).then(() => null)]);
    if (next === null) continue;
    if (next.done) break;
    out += new TextDecoder().decode(next.value);
  }
  const port = Number(/Tapalog Reader\s+http:\/\/localhost:(\d+)\//.exec(out)?.[1]);
  return { child, port };
}

test("a second start on the same data folder finds the running program and ends without starting another", async () => {
  const data = join(base, "data-single");
  const first = await startKept(data);
  try {
    expect(first.port).toBeGreaterThan(0);
    const second = await startAndReadAll(data);
    expect(second.exit).toBe(0);
    expect(second.out).toContain(`already running: http://localhost:${first.port}/`);
    expect(second.out).not.toContain("Data folder");
  } finally {
    first.child.kill();
    await first.child.exited;
  }
}, 30_000);

test("a note left by a program that is gone does not stop a new start", async () => {
  const data = join(base, "data-stale");
  mkdirSync(data, { recursive: true });
  // the note points at a port where something answers, but it is not Tapalog Reader
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not ours") });
  const freed = probe.port;
  writeFileSync(join(data, "instance.json"), JSON.stringify({ port: freed, pid: 1 }));
  try {
    const { child, port } = await startKept(data);
    expect(port).toBeGreaterThan(0);
    child.kill();
    await child.exited;
  } finally {
    probe.stop(true);
  }
  // and a note that is not even readable
  writeFileSync(join(data, "instance.json"), "not json at all");
  const again = await startKept(data);
  expect(again.port).toBeGreaterThan(0);
  again.child.kill();
  await again.child.exited;
}, 30_000);

/** Runs the program to its end and returns everything it printed. */
async function startAndReadAll(data: string): Promise<{ out: string; exit: number | null }> {
  const lib = join(base, "lib");
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "main.ts"), "--library", lib, "--data", data, "--host", "127.0.0.1", "--no-open"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15_000);
  const out = await new Response(child.stdout as ReadableStream).text();
  await child.exited;
  clearTimeout(timer);
  return { out, exit: child.exitCode };
}
