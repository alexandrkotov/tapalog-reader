import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sources = ["src/web/editor/bundle.ts", "src/web/editor/textRules.ts", "scripts/gen-editor-assets.ts"];
const packages = ["@milkdown/kit", "@milkdown/plugin-math", "katex"];

/**
 * A fingerprint of what the built editor in assets/editor/ is made from: its sources and the versions of the libraries in it.
 * gen-editor-assets.ts writes it beside the build, and a test compares it with the present one, so a change of the editor
 * that was not built again is caught (the build itself is not compared: another version of Bun may write it a little differently).
 */
export function editorSourceHash(): string {
  const hash = createHash("sha256");
  for (const file of sources) hash.update(file + "\n" + readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n") + "\n");
  for (const name of packages) hash.update(`${name}@${(JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version: string }).version}\n`);
  return hash.digest("hex");
}
