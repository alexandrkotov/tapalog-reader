import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrowseError, browse } from "./browse";
import { removeDir } from "./testutil";

const root = mkdtempSync(join(tmpdir(), "reader-browse-"));
afterAll(() => removeDir(root));

mkdirSync(join(root, "Beta"));
mkdirSync(join(root, "alpha"));
mkdirSync(join(root, "item 10"));
mkdirSync(join(root, "item 2"));
mkdirSync(join(root, ".hidden"));
writeFileSync(join(root, "book.pdf"), "x");
writeFileSync(join(root, "story.fb2"), "x");
writeFileSync(join(root, "notes.docx"), "x");

const refused = async (path: string | null) => {
  try {
    await browse(path);
    return "no error";
  } catch (err) {
    return err instanceof BrowseError ? err.message : String(err);
  }
};

test("a folder lists its sub-folders only, sorted the way people count, and says how many books lie in it", async () => {
  const listing = await browse(root);
  expect(listing).toMatchObject({ path: root, parent: dirname(root), dirs: ["alpha", "Beta", "item 2", "item 10"], books: 2, truncated: false });
});

test("a link to a folder counts as a folder, a link to nothing does not", async () => {
  try {
    symlinkSync(join(root, "alpha"), join(root, "shortcut"), "dir");
    symlinkSync(join(root, "missing"), join(root, "dangling"), "dir");
  } catch {
    return; // links need a privilege on some systems
  }
  expect((await browse(root)).dirs).toContain("shortcut");
  expect((await browse(root)).dirs).not.toContain("dangling");
});

test("without a path it starts at the home folder, and only an absolute folder that exists is listed", async () => {
  expect((await browse(null)).path).toBe((await browse(null)).home);
  expect(await refused("relative/folder")).toBe("not a folder");
  expect(await refused(join(root, "nowhere"))).toBe("not a folder");
  expect(await refused(join(root, "book.pdf"))).toBe("not a folder");
});

test("the top of the disk has no parent on Linux and macOS, and the list of drives above it on Windows", async () => {
  const top = await browse(process.platform === "win32" ? "C:\\" : "/");
  expect(top.parent).toBe(process.platform === "win32" ? "" : null);
  if (process.platform === "win32") expect((await browse("")).dirs).toContain("C:\\");
});
