import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupExtracted, extractEmbeddedBinary } from "./embedCloudflared";

test("copies of the embedded binary left by dead processes are removed, live ones kept, and this run's copy is deleted on cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-tmp-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir; // os.tmpdir() reads it at call time
  try {
    const source = join(dir, "source-binary");
    writeFileSync(source, "pretend this is cloudflared");
    const dead = join(dir, "tapalog-reader-cloudflared-2147483000");
    const alive = join(dir, `tapalog-reader-cloudflared-${process.ppid}`);
    const unrelated = join(dir, "tapalog-reader-cloudflared-notes.txt");
    for (const f of [dead, alive, unrelated]) writeFileSync(f, "x");

    const mine = await extractEmbeddedBinary(source, "tapalog-reader-cloudflared");
    expect(mine).toBe(join(dir, `tapalog-reader-cloudflared-${process.pid}`));
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(mine)).toBe(true);

    cleanupExtracted();
    expect(existsSync(mine)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
