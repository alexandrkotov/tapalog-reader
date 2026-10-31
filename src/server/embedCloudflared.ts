import { chmodSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A `bun build --compile`'d executable's `with { type: "file" }` imports
 * resolve to a virtual `$bunfs/...` path — real enough for Bun's own file
 * APIs (`Bun.file`, `fs`) to read, but *not* a real filesystem entry the OS
 * can actually exec: `Bun.spawn` on it fails with ENOENT (confirmed by
 * hand while building this), and the extracted bytes don't carry over the
 * source file's executable permission bit either way. This copies the
 * embedded binary's real bytes out to a genuine temp file and marks it
 * executable, once per process start — that's the file every
 * main.compiled.<platform>.ts entry point actually points CLOUDFLARED_PATH
 * at.
 *
 * The temp filename includes this process's own pid: a fixed shared name
 * across launches means a second launch's `Bun.write` (open+truncate)
 * collides with a still-running earlier instance's cloudflared holding
 * that same file open for execution, and fails with `ETXTBSY: text file
 * is busy` — caught live running the collab-server snap package twice in
 * a row (2026-09-13), not specific to snap/Linux packaging.
 */
let extractedPath: string | null = null;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM"; // exists, just not ours to signal
  }
}

/**
 * Each start copies ~40 MB into the temp folder under a pid-specific name, so
 * a crash or a Windows exit (a running .exe can't be deleted) would leave one
 * behind every time. Copies whose process is gone are removed at the next start.
 */
function removeStaleCopies(tempName: string): void {
  const dot = tempName.lastIndexOf(".");
  const base = dot > 0 ? tempName.slice(0, dot) : tempName;
  const ext = dot > 0 ? tempName.slice(dot) : "";
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  try {
    for (const name of readdirSync(tmpdir())) {
      const pid = pattern.exec(name)?.[1];
      if (pid && Number(pid) !== process.pid && !isAlive(Number(pid))) rmSync(join(tmpdir(), name), { force: true });
    }
  } catch {
    // an unreadable temp folder only means a stale copy stays a little longer
  }
}

/** Deletes this run's copy; best effort (Windows refuses while the tunnel process still holds it). */
export function cleanupExtracted(): void {
  if (!extractedPath) return;
  try {
    rmSync(extractedPath, { force: true });
    extractedPath = null;
  } catch {
    // removed by removeStaleCopies on the next start
  }
}

export async function extractEmbeddedBinary(embeddedPath: string, tempName: string): Promise<string> {
  // Insert the pid before any extension (rather than just appending it)
  // so Windows keeps its literal ".exe" tempName suffix at the real end
  // of the filename.
  const dot = tempName.lastIndexOf(".");
  const uniqueName = dot > 0 ? `${tempName.slice(0, dot)}-${process.pid}${tempName.slice(dot)}` : `${tempName}-${process.pid}`;
  removeStaleCopies(tempName);
  const realPath = join(tmpdir(), uniqueName);
  await Bun.write(realPath, Bun.file(embeddedPath));
  chmodSync(realPath, 0o755);
  extractedPath = realPath;
  return realPath;
}
