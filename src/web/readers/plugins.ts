import { t } from "../i18n";
import { isDark, onTheme } from "../theme";
import { api } from "../ui";
import type { Reader, ReaderSpec } from "./mount";

/** What the server says about an installed plugin (see src/server/plugins.ts). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  exts: string[];
  /** Address of the plugin's reader module. */
  reader: string;
  /** Whether a share link can carry the reader's view (its place in the book). */
  shareableView: boolean;
}

/** What a plugin's `mount(host, context)` is given. The plugin draws into `host` and owns it until `destroy`. */
export interface PluginContext {
  /** Where the file bytes come from: a library file or a share link's file (same origin, cookies included). */
  url: string;
  name: string;
  ext: string;
  /** A view to open at: whatever the plugin's own getView returned earlier, or null. */
  view: unknown;
  /** Report the current view whenever it changes. */
  onView(view: unknown): void;
  /** Show the user that the book could not be opened. */
  onError(title: string, text: string): void;
  theme: "light" | "dark";
  /** Be told when the theme changes; returns the way to stop. */
  onTheme(fn: (theme: "light" | "dark") => void): () => void;
}

/** What a plugin's `mount` returns. */
export interface PluginReader {
  destroy(): void;
  getView?(): unknown;
  getLabel?(): string;
}

let installed: PluginInfo[] = [];

/** Asks the server which plugins are installed; none if it cannot say. */
export async function loadPlugins(): Promise<void> {
  installed = await api<{ plugins: PluginInfo[] }>("/api/plugins").then((r) => r.plugins, () => []);
}

/** The plugin that reads books of this format, if any. */
export const pluginFor = (ext: string): PluginInfo | undefined => installed.find((p) => p.exts.includes(ext));

/** Mounts the plugin's reader for the book. The module is loaded on first use, from the app's own address. */
export async function mountPlugin(host: HTMLElement, plugin: PluginInfo, spec: ReaderSpec): Promise<Reader> {
  const address: string = plugin.reader;
  const module = (await import(/* webpackIgnore: true */ address)) as { mount?: (host: HTMLElement, context: PluginContext) => PluginReader | Promise<PluginReader> };
  if (typeof module.mount !== "function") throw new Error(`${plugin.name}: the reader has no mount function`);
  const reader = await module.mount(host, {
    url: spec.fileUrl,
    name: spec.name,
    ext: spec.ext,
    view: spec.view ?? null,
    onView: (view) => spec.onView?.(view),
    onError: spec.onError,
    theme: isDark() ? "dark" : "light",
    onTheme: (fn) => onTheme(() => fn(isDark() ? "dark" : "light")),
  });
  return { destroy: () => reader.destroy(), getView: reader.getView?.bind(reader), getLabel: reader.getLabel?.bind(reader) };
}

export const pluginError = (): string => t("plugin.error");
