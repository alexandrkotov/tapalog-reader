import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { isCompiled } from "./dataDir";
import { formatOf } from "./formats";

/**
 * Plugins add readers for book formats the program cannot open itself. A plugin is a folder inside
 * the plugins folder (`plugins/` next to the program, or --plugins / TAPALOG_PLUGINS):
 *
 *   plugins/djvu/plugin.json   { "id": "djvu", "name": "DjVu reader", "version": "1.0.0",
 *                                "formats": [{ "ext": ["djvu", "djv"], "mime": "image/vnd.djvu" }],
 *                                "reader": "reader.js", "shareableView": true, "cover": true }
 *   plugins/djvu/reader.js     an ES module that exports `mount(host, context)` and optionally `cover(context)` (see guide/plugins.md)
 *
 * A plugin is code that runs in every reader's browser, so plugins are put in the folder by the person
 * who runs the server and by nobody else: nothing here installs or downloads one. The server only
 * lists them and serves their files read-only. Built-in formats keep their own readers.
 *
 * The contract between the program and a plugin (what `mount` and `cover` are given and may return) has a version, PLUGIN_API.
 * A manifest says which one it was written for with "api" (1 when it says nothing). Changes that only add something (a new field
 * in the context, an optional export) keep the number; a change that could break a plugin written for the old one raises it, and
 * a plugin that asks for a number above the program's is skipped with the reason, rather than failing in somebody's reader.
 */
export const PLUGIN_API = 1;

export interface Plugin {
  id: string;
  name: string;
  version: string;
  /** The version of the plugin contract it was written for (see PLUGIN_API). */
  api: number;
  /** Lower-case extensions without the dot, the first one being the format's name in the library. */
  exts: string[];
  mime: string;
  /** The reader module, relative to the plugin's folder, with "/" separators. */
  reader: string;
  /** Whether the reader's view can be put in a share link or a bookmark. */
  shareableView: boolean;
  /** Whether the module also exports `cover(context)`, which draws the book's cover thumbnail. */
  cover: boolean;
  dir: string;
}

export interface PluginProblem {
  folder: string;
  problem: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EXT = /^[a-z0-9]{1,10}$/;
const MAX_PLUGINS = 50;

const TYPES: Record<string, string> = {
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  css: "text/css",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  map: "application/json",
};

export function defaultPluginsDir(override?: string): string {
  const explicit = override ?? process.env.TAPALOG_PLUGINS;
  return explicit ?? join(isCompiled() ? dirname(process.execPath) : process.cwd(), "plugins");
}

/** A path inside a plugin, as the manifest writes it: relative, no "..", no drive or root. */
const inside = (rel: unknown): rel is string => typeof rel === "string" && !!rel && !rel.includes("\\") && !rel.includes("\0") && !rel.startsWith("/") && rel.split("/").every((part) => part !== ".." && part !== "." && part !== "");

export class Plugins {
  readonly plugins: Plugin[] = [];
  readonly problems: PluginProblem[] = [];

  constructor(readonly dir: string) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    const taken = new Map<string, string>(); // extension -> the plugin that has it
    for (const folder of readdirSync(dir).sort()) {
      if (folder.startsWith(".") || this.plugins.length >= MAX_PLUGINS) continue;
      const abs = join(dir, folder);
      if (!statSync(abs).isDirectory()) continue;
      try {
        const plugin = this.read(folder, abs);
        const clash = plugin.exts.find((e) => taken.has(e));
        if (clash) throw new Error(`the extension .${clash} already belongs to the plugin "${taken.get(clash)}"`);
        for (const e of plugin.exts) taken.set(e, plugin.id);
        this.plugins.push(plugin);
      } catch (err) {
        this.problems.push({ folder, problem: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private read(folder: string, abs: string): Plugin {
    const manifest = join(abs, "plugin.json");
    if (!existsSync(manifest)) throw new Error("no plugin.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifest, "utf-8"));
    } catch {
      throw new Error("plugin.json is not valid JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("plugin.json must be an object");
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || !ID.test(m.id)) throw new Error('"id" must be lower-case letters, digits and dashes');
    if (m.id !== folder) throw new Error(`"id" (${m.id}) must be the name of the folder (${folder})`);
    if (m.api !== undefined && (typeof m.api !== "number" || !Number.isInteger(m.api) || m.api < 1)) throw new Error('"api" must be a whole number from 1');
    const api = typeof m.api === "number" ? m.api : 1;
    if (api > PLUGIN_API) throw new Error(`it is written for plugin API ${api}, and this program has ${PLUGIN_API}: a newer version of the program is needed`);
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 60) throw new Error('"name" is missing or too long');
    if (m.version !== undefined && (typeof m.version !== "string" || m.version.length > 20)) throw new Error('"version" must be a short text');
    if (!Array.isArray(m.formats) || !m.formats.length || m.formats.length > 10) throw new Error('"formats" must list one to ten formats');
    const exts: string[] = [];
    let mime = "application/octet-stream";
    for (const format of m.formats as unknown[]) {
      if (!format || typeof format !== "object") throw new Error('"formats" holds something that is not a format');
      const f = format as Record<string, unknown>;
      const list = Array.isArray(f.ext) ? f.ext : [f.ext];
      for (const ext of list) {
        if (typeof ext !== "string" || !EXT.test(ext.toLowerCase())) throw new Error(`"${String(ext)}" is not an extension (letters and digits, without the dot)`);
        if (!exts.includes(ext.toLowerCase())) exts.push(ext.toLowerCase());
      }
      if (f.mime !== undefined) {
        if (typeof f.mime !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(f.mime)) throw new Error('"mime" is not a media type');
        if (mime === "application/octet-stream") mime = f.mime;
      }
    }
    if (!inside(m.reader) || ![".js", ".mjs"].includes(extname(m.reader))) throw new Error('"reader" must be a .js or .mjs file inside the plugin folder');
    if (!existsSync(join(abs, ...m.reader.split("/")))) throw new Error(`the reader file ${m.reader} is missing`);
    return { id: m.id, name: m.name.trim(), version: typeof m.version === "string" ? m.version : "", api, exts, mime, reader: m.reader, shareableView: m.shareableView === true, cover: m.cover === true, dir: abs };
  }

  /** What the page needs to know to use a plugin. */
  describe() {
    return this.plugins.map((p) => ({ id: p.id, name: p.name, version: p.version, api: p.api, exts: p.exts, reader: `/plugins/${p.id}/${p.reader}`, shareableView: p.shareableView, cover: p.cover }));
  }

  /** The library's names of the formats whose plugin draws covers. */
  coverFormats(): string[] {
    return [...new Set(this.plugins.filter((p) => p.cover).flatMap((p) => p.exts.flatMap((ext) => formatOf(`x.${ext}`) ?? [])))];
  }

  /** extension -> media type, for the file endpoint and the scanner. */
  formats(): { exts: string[]; mime: string }[] {
    return this.plugins.map((p) => ({ exts: p.exts, mime: p.mime }));
  }

  /** The file for a request path inside a plugin, or null: only real files inside that plugin's folder are ever served. */
  file(id: string, rest: string[]): { path: string; type: string } | null {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin || !rest.length || !rest.every((part) => part && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0") && !part.includes(":"))) return null;
    const path = join(plugin.dir, ...rest);
    try {
      const real = realpathSync(path);
      const root = realpathSync(plugin.dir);
      if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null; // a link pointing out of the folder is not followed
      return { path: real, type: TYPES[extname(real).slice(1).toLowerCase()] ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }
}

