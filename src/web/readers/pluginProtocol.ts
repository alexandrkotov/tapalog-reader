/**
 * The messages between the program's page and the sandboxed frame of an isolated plugin (see src/server/pluginBridge.js, which
 * is the other end). No DOM in this file, so that what a frame may say can be checked by tests.
 */

/** What the frame says. Everything a frame sends is data from a plugin: it is checked before it is believed. */
export type FromFrame =
  | { t: "ready" }
  | { t: "mounted" }
  | { t: "failed"; message: string }
  | { t: "view"; view: unknown; label: string }
  | { t: "error"; title: string; text: string }
  | { t: "need-file"; id: number }
  | { t: "cover"; image: Blob | ImageBitmap }
  | { t: "cover-failed"; message: string; retry: boolean };

const text = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The message if it is one the frame may send and has the right shape, else null. */
export function parseFromFrame(data: unknown): FromFrame | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case "ready":
    case "mounted":
      return { t: m.t };
    case "failed":
      return { t: "failed", message: text(m.message) || "the plugin failed" };
    case "view":
      return { t: "view", view: m.view ?? null, label: text(m.label, 200) };
    case "error":
      return { t: "error", title: text(m.title, 200), text: text(m.text) };
    case "need-file":
      return Number.isSafeInteger(m.id) ? { t: "need-file", id: m.id as number } : null;
    case "cover":
      return m.image instanceof Blob || (typeof ImageBitmap === "function" && m.image instanceof ImageBitmap) ? { t: "cover", image: m.image } : null;
    case "cover-failed":
      return { t: "cover-failed", message: text(m.message) || "no cover", retry: m.retry === true };
    default:
      return null;
  }
}

/** The address of the page an isolated plugin runs in. */
export const frameAddress = (id: string): string => `/plugin-host/${encodeURIComponent(id)}`;

/** How long a frame has to say it is ready (its script loaded) before the plugin is given up. */
export const READY_MS = 15_000;
