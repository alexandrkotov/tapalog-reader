import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editorSourceHash } from "../../../scripts/editor-source";

test("the built editor in assets/editor is made from the sources and libraries that are there now", () => {
  const built = readFileSync(join(import.meta.dir, "../../../assets/editor/source.sha256"), "utf8").trim();
  // when this fails, the editor was changed (or a library upgraded) and not built again: bun run gen:editor
  expect(built).toBe(editorSourceHash());
});
