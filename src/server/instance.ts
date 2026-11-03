import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One program per data folder. A running program leaves a small file there with its port; a second start
 * looks, finds the first still answering, and just opens it in the browser instead of starting another
 * server on the next port (two servers on one set of data would only get in each other's way). A file left
 * behind by a program that did not exit cleanly is ignored: nothing answers at its port, or something else does.
 */
const FILE = "instance.json";
export const PING = "/api/ping";
export const APP_NAME = "tapalog-reader";

/** The port of the program already running on this data folder, or null if there is none. */
export async function runningInstance(dataDir: string, timeoutMs = 1500): Promise<number | null> {
  let port: unknown;
  try {
    port = (JSON.parse(readFileSync(join(dataDir, FILE), "utf-8")) as { port?: unknown }).port;
  } catch {
    return null;
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${PING}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as { app?: unknown };
    return body.app === APP_NAME ? port : null;
  } catch {
    return null;
  }
}

/** Says that this program is running on `port`; the returned function takes the note away again (only if it is still this program's). */
export function recordInstance(dataDir: string, port: number): () => void {
  const path = join(dataDir, FILE);
  try {
    writeFileSync(path, JSON.stringify({ port, pid: process.pid }));
  } catch {
    return () => {}; // a read-only data folder: the program still runs, it just cannot be found by a second start
  }
  return () => {
    try {
      if ((JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown }).pid === process.pid) rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  };
}
