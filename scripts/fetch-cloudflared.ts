/**
 * Downloads the real `cloudflared` binary for one target platform into
 * `vendor/` (gitignored — fetched, not authored), so the matching
 * `src/main.compiled.<platform>.ts` entry point can embed it into that
 * platform's `bun build --compile` output. Run automatically by each
 * `compile:*` script in package.json — not meant to be run standalone,
 * though it's harmless to.
 *
 * Usage: bun run scripts/fetch-cloudflared.ts <platform>
 */

import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

interface PlatformSpec {
  /** Exact asset filename on cloudflared's GitHub Releases. */
  asset: string;
  /** macOS release assets are a .tgz containing a plain `cloudflared` binary; every other platform ships the raw binary/exe directly. */
  archive: "raw" | "tgz";
  /** What this ends up named under vendor/ — must match the literal path each main.compiled.<platform>.ts imports. */
  outName: string;
}

const PLATFORMS: Record<string, PlatformSpec> = {
  "linux-x64": { asset: "cloudflared-linux-amd64", archive: "raw", outName: "cloudflared-linux-x64" },
  "linux-arm64": { asset: "cloudflared-linux-arm64", archive: "raw", outName: "cloudflared-linux-arm64" },
  "darwin-x64": { asset: "cloudflared-darwin-amd64.tgz", archive: "tgz", outName: "cloudflared-darwin-x64" },
  "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", archive: "tgz", outName: "cloudflared-darwin-arm64" },
  "windows-x64": { asset: "cloudflared-windows-amd64.exe", archive: "raw", outName: "cloudflared-windows-x64.exe" },
};

const platform = process.argv[2];
const spec = platform ? PLATFORMS[platform] : undefined;
if (!spec) {
  console.error(`Usage: bun run scripts/fetch-cloudflared.ts <${Object.keys(PLATFORMS).join("|")}>`);
  process.exit(1);
}

// plain file-system calls and real paths (not URL pathnames), so this also runs on Windows, where the Windows build is made
const vendorDir = fileURLToPath(new URL("../vendor/", import.meta.url));
mkdirSync(vendorDir, { recursive: true });
const outPath = join(vendorDir, spec.outName);

const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${spec.asset}`;
console.log(`Fetching ${downloadUrl} …`);
// Deliberately curl, not Bun's global fetch()+Bun.write — that combination
// was confirmed by hand to hang indefinitely on this exact download (no
// error, no progress, just stuck) on more than one machine, while curl on
// the identical URL consistently finished in seconds. Whatever's behind
// that (a Bun streaming-response quirk, most likely) wasn't worth chasing
// down when curl already does the job reliably and ships by default on
// Linux, macOS, and Windows 10 1803+ alike.
async function curlDownload(target: string): Promise<void> {
  await Bun.$`curl -fsSL --retry 3 --retry-delay 2 -o ${target} ${downloadUrl}`;
}

if (spec.archive === "raw") {
  await curlDownload(outPath);
} else {
  const tmpTgz = join(vendorDir, `_${spec.outName}.tgz`);
  await curlDownload(tmpTgz);
  // The archive contains one file, literally named "cloudflared" — extract
  // straight into vendor/ then rename to this platform's outName.
  await Bun.$`tar -xzf ${tmpTgz} -C ${vendorDir}`;
  renameSync(join(vendorDir, "cloudflared"), outPath);
  rmSync(tmpTgz);
}
try {
  chmodSync(outPath, 0o755);
} catch {
  /* chmod is a no-op-ish concept on Windows binaries; ignore rather than fail the build over it */
}

console.log(`Wrote ${outPath} (${(await Bun.file(outPath).arrayBuffer()).byteLength} bytes)`);
