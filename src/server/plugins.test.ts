import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOf, mimeOf, registerFormats } from "./formats";
import { Plugins } from "./plugins";
import { removeDir } from "./testutil";

const base = mkdtempSync(join(tmpdir(), "reader-plugins-"));
afterAll(() => {
  registerFormats([]);
  removeDir(base);
});

/** Makes a plugins folder from {folder: manifest or [manifest, files]}. */
function install(spec: Record<string, unknown>, files: Record<string, Record<string, string>> = {}): Plugins {
  const dir = mkdtempSync(join(base, "p-"));
  for (const [folder, manifest] of Object.entries(spec)) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    for (const [name, content] of Object.entries(files[folder] ?? { "reader.js": "export function mount() {}" })) {
      mkdirSync(join(dir, folder, ...name.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, folder, ...name.split("/")), content);
    }
  }
  return new Plugins(dir);
}
const good = (over: object = {}) => ({ id: "demo", name: "Demo", formats: [{ ext: "demo" }], reader: "reader.js", ...over });

test("a folder without a plugins folder is simply no plugins", () => {
  const none = new Plugins(join(base, "does-not-exist"));
  expect(none.plugins).toEqual([]);
  expect(none.problems).toEqual([]);
});

test("a good manifest becomes a plugin, with its extensions in lower case and the first media type", () => {
  const p = install({ demo: good({ version: "2.0", shareableView: true, formats: [{ ext: ["DEMO", "dm"], mime: "application/x-demo" }, { ext: "demo2", mime: "application/x-other" }] }) });
  expect(p.problems).toEqual([]);
  expect(p.plugins[0]).toMatchObject({ id: "demo", name: "Demo", version: "2.0", exts: ["demo", "dm", "demo2"], mime: "application/x-demo", reader: "reader.js", shareableView: true });
  expect(p.describe()).toEqual([{ id: "demo", name: "Demo", version: "2.0", exts: ["demo", "dm", "demo2"], reader: "/plugins/demo/reader.js", shareableView: true }]);
});

test("a bad manifest skips that plugin only, and says why", () => {
  const p = install(
    {
      ok: good({ id: "ok" }),
      "no-json": "{ not json",
      "wrong-id": good({ id: "other" }),
      "bad id": good({ id: "Bad Id" }),
      noname: good({ id: "noname", name: "" }),
      "no-formats": good({ id: "no-formats", formats: [] }),
      "bad-ext": good({ id: "bad-ext", formats: [{ ext: ".pdf!" }] }),
      "bad-mime": good({ id: "bad-mime", formats: [{ ext: "x", mime: "nonsense" }] }),
      outside: good({ id: "outside", reader: "../ok/reader.js" }),
      absolute: good({ id: "absolute", reader: "/etc/passwd" }),
      backslash: good({ id: "backslash", reader: "sub\\reader.js" }),
      notjs: good({ id: "notjs", reader: "reader.txt" }),
      missing: good({ id: "missing", reader: "nothing.js" }),
      array: "[]",
    },
    { "no-json": {}, notjs: { "reader.txt": "x" }, missing: {} },
  );
  expect(p.plugins.map((x) => x.id)).toEqual(["ok"]);
  const why = Object.fromEntries(p.problems.map((x) => [x.folder, x.problem]));
  expect(why["no-json"]).toContain("not valid JSON");
  expect(why["wrong-id"]).toContain("must be the name of the folder");
  expect(why["bad id"]).toContain('"id"');
  expect(why.noname).toContain('"name"');
  expect(why["no-formats"]).toContain('"formats"');
  expect(why["bad-ext"]).toContain("not an extension");
  expect(why["bad-mime"]).toContain("media type");
  for (const folder of ["outside", "absolute", "backslash", "notjs"]) expect(why[folder]).toContain('"reader"');
  expect(why.missing).toContain("is missing");
  expect(why.array).toContain("must be an object");
});

test("two plugins cannot claim the same extension: the first by name keeps it", () => {
  const p = install({ a: good({ id: "a", formats: [{ ext: "same" }] }), b: good({ id: "b", formats: [{ ext: ["other", "same"] }] }) });
  expect(p.plugins.map((x) => x.id)).toEqual(["a"]);
  expect(p.problems).toEqual([{ folder: "b", problem: 'the extension .same already belongs to the plugin "a"' }]);
});

test("only real files inside the plugin's own folder are served", () => {
  const p = install({ demo: good() }, { demo: { "reader.js": "export {}", "lib/deep/file.wasm": "w", "data.bin": "b" } });
  mkdirSync(join(p.dir, "outside"));
  writeFileSync(join(p.dir, "outside", "secret.txt"), "secret");
  try {
    symlinkSync(join(p.dir, "outside", "secret.txt"), join(p.dir, "demo", "link.txt"));
  } catch {
    /* no symlinks allowed here: the check below then holds for nothing to follow */
  }
  expect(p.file("demo", ["reader.js"])?.type).toBe("text/javascript");
  expect(p.file("demo", ["lib", "deep", "file.wasm"])?.type).toBe("application/wasm");
  expect(p.file("demo", ["data.bin"])?.type).toBe("application/octet-stream");
  for (const rest of [[], [""], [".."], ["..", "outside", "secret.txt"], ["lib"], ["nothing"], ["a\\b"], ["c:"], ["x\0"], ["link.txt"]]) expect(p.file("demo", rest)).toBeNull();
  expect(p.file("other", ["reader.js"])).toBeNull();
});

test("plugin formats join the library's, but a built-in extension is never taken over", () => {
  registerFormats([{ exts: ["demo", "dm"], mime: "application/x-demo" }, { exts: ["pdf", "pdfx"], mime: "application/x-hijack" }]);
  expect(formatOf("a.demo")).toBe("demo");
  expect(formatOf("a.DM")).toBe("demo");
  expect(formatOf("a.pdf")).toBe("pdf"); // still the built-in one
  expect(formatOf("a.pdfx")).toBe("pdfx"); // the plugin keeps its new extension, named after itself, but not .pdf
  expect(formatOf("a.djv")).toBe("djvu");
  expect(formatOf("a.unknown")).toBeNull();
  expect(mimeOf("demo")).toBe("application/x-demo");
  expect(mimeOf("pdf")).toBe("application/pdf");
  expect(mimeOf("nothing")).toBe("application/octet-stream");
  registerFormats([]);
  expect(formatOf("a.demo")).toBeNull();
});
