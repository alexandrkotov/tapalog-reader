import { watch, type FSWatcher } from "node:fs";

/**
 * Calls `onChange` once after a burst of file events settles (copying a whole
 * folder produces thousands of events). Native watching is unreliable on USB
 * and network drives, and has OS limits on big trees, so a slow periodic call
 * is the safety net — and the admin's Rescan button is the last resort.
 */
export function watchLibrary(root: string, onChange: () => void, options: { debounceMs?: number; periodicMs?: number } = {}): () => void {
  const debounceMs = options.debounceMs ?? 1500;
  const periodicMs = options.periodicMs ?? 10 * 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name && name.split(/[\\/]/).some((part) => part.startsWith("."))) return;
      trigger();
    });
    watcher.on("error", () => {}); // keep the periodic rescan as the fallback
  } catch {
    // watching unsupported here: periodic rescan only
  }
  const interval = setInterval(onChange, periodicMs);

  return () => {
    watcher?.close();
    clearInterval(interval);
    if (timer) clearTimeout(timer);
  };
}
