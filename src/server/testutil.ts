import { rmSync } from "node:fs";

/**
 * Removes a temporary folder after a test. Windows refuses to delete a file that is still open and
 * is slow to let go of one just closed (antivirus, indexers), so this retries and, in the end,
 * leaves the folder to the operating system rather than failing a test that already passed.
 */
export function removeDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(100);
    }
  }
}
