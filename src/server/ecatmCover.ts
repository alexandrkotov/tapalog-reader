import { indexCatalog } from "@ecm/viewer-engine/server";
import wasmPath from "sql.js/dist/sql-wasm.wasm" with { type: "file" };

// The engine's server entry runs the sql.js in node_modules, so it needs the wasm of that same
// package (not the browser build the viewer ships): the two are built as a pair.
let wasm: Promise<Uint8Array> | null = null;

/**
 * The first picture of a `.ecatm` catalog as stored (any size: the browser scales it down).
 * A password-protected catalog still gives up the cover its author made public.
 */
export async function ecatmCover(path: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  wasm ??= Bun.file(wasmPath).bytes();
  const digest = await indexCatalog(await Bun.file(path).bytes(), { wasm: await wasm });
  return digest.cover ? { mime: digest.cover.mime, bytes: digest.cover.bytes } : null;
}
