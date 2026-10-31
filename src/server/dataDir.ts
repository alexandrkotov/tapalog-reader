import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const DIR_NAME = "tapalog-reader-data";

/** True when running as a `bun build --compile` executable rather than `bun run`. */
export function isCompiled(): boolean {
  return !basename(process.execPath).toLowerCase().startsWith("bun");
}

function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-test-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where everything the app creates (database, previews, backups, settings)
 * lives: a folder next to the executable. Snap/Store installs and read-only
 * media can't be written next to the binary, so then it falls back to the
 * home directory. `TAPALOG_DATA` / `--data` override both.
 */
export function resolveDataDir(override?: string): string {
  const explicit = override ?? process.env.TAPALOG_DATA;
  if (explicit) {
    mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  const nextToExe = join(isCompiled() ? dirname(process.execPath) : process.cwd(), DIR_NAME);
  if (isWritableDir(nextToExe)) return nextToExe;
  const fallback = join(homedir(), `.${DIR_NAME}`);
  mkdirSync(fallback, { recursive: true });
  return fallback;
}
