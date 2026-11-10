import { isDark, onTheme } from "../theme";
import type { Reader, ReaderSpec } from "./mount";
import { frameAddress, parseFromFrame, READY_MS, type FromFrame } from "./pluginProtocol";
import type { PluginInfo } from "./plugins";

/**
 * Runs an isolated plugin (API 2) in a frame that cannot reach this page: <iframe sandbox="allow-scripts"> has no
 * `allow-same-origin`, so the plugin has no cookies, no storage of this site, no way into this page's DOM and no login of its
 * own. What it needs it is given by message: the book's bytes (fetched here, with the reader's login), the theme, and the
 * place to open at. What it does comes back the same way: the place it is at, errors, and a cover. The other end of the
 * conversation is src/server/pluginBridge.js.
 */
class PluginFrame {
  readonly element = document.createElement("iframe");
  private readonly listener: (event: MessageEvent) => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private ended = false;

  constructor(
    plugin: PluginInfo,
    private readonly fileUrl: string,
    private readonly init: Record<string, unknown>,
    private readonly on: (message: FromFrame) => void,
  ) {
    this.element.setAttribute("sandbox", "allow-scripts"); // and nothing else: not allow-same-origin, not popups, not top navigation
    this.element.src = frameAddress(plugin.id);
    this.element.title = plugin.name;
    this.element.style.cssText = "border:0;display:block;width:100%;height:100%;background:transparent";
    this.listener = (event) => {
      if (event.source !== this.element.contentWindow) return; // only this plugin's frame, whatever else posts to this page
      const message = parseFromFrame(event.data);
      if (!message || this.ended) return;
      if (message.t === "ready") {
        clearTimeout(this.timer);
        this.post(this.init);
      } else if (message.t === "need-file") void this.sendFile(message.id);
      else this.on(message);
    };
    window.addEventListener("message", this.listener);
    this.timer = setTimeout(() => this.on({ t: "failed", message: "the plugin's frame did not start" }), READY_MS);
  }

  post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
    this.element.contentWindow?.postMessage(message, "*", transfer); // an opaque origin can only be addressed as "*"; the window is this plugin's own frame
  }

  private async sendFile(id: number): Promise<void> {
    try {
      const res = await fetch(this.fileUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`The server answered ${res.status}`);
      const buffer = await res.arrayBuffer();
      this.post({ t: "file", id, buffer }, [buffer]);
    } catch (err) {
      this.post({ t: "file", id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  end(): void {
    this.ended = true;
    clearTimeout(this.timer);
    window.removeEventListener("message", this.listener);
    this.element.remove();
  }
}

const theme = () => (isDark() ? "dark" : "light");

/** Mounts an isolated plugin's reader for the book in a frame inside `host`. */
export function mountIsolated(host: HTMLElement, plugin: PluginInfo, spec: ReaderSpec): Promise<Reader> {
  return new Promise<Reader>((resolve, reject) => {
    let view: unknown = spec.view ?? null; // until the plugin reports a place, the one it was opened at
    let label = "";
    let mounted = false;
    const frame: PluginFrame = new PluginFrame(
      plugin,
      spec.fileUrl,
      { t: "init", mode: "mount", reader: new URL(plugin.reader, location.origin).href, api: plugin.api, name: spec.name, ext: spec.ext, view: spec.view ?? null, theme: theme() },
      (m) => {
        if (m.t === "mounted") {
          mounted = true;
          resolve({
            destroy() {
              stopTheme();
              frame.post({ t: "destroy" });
              frame.end();
            },
            getView: () => view,
            getLabel: () => label || undefined,
          } as Reader);
        } else if (m.t === "failed" && !mounted) {
          stopTheme();
          frame.end();
          reject(new Error(m.message));
        } else if (m.t === "view") {
          view = m.view;
          label = m.label;
          spec.onView?.(m.view);
        } else if (m.t === "error") spec.onError(m.title, m.text);
      },
    );
    const stopTheme = onTheme(() => frame.post({ t: "theme", theme: theme() }));
    host.replaceChildren(frame.element);
  });
}

/** What a plugin's cover came to: the image (a Blob or an ImageBitmap), or why there is none and whether to try again later. */
export type FrameCover = { image: Blob | ImageBitmap } | { failed: string; retry: boolean };

const COVER_MS = 60_000;

/** Asks an isolated plugin for a book's cover, in a hidden frame that lives only as long as the answer takes. */
export function coverFromFrame(plugin: PluginInfo, fileUrl: string, ext: string, width: number, height: number): Promise<FrameCover> {
  return new Promise<FrameCover>((resolve) => {
    const finish = (result: FrameCover) => {
      clearTimeout(timer);
      frame.end();
      resolve(result);
    };
    const frame: PluginFrame = new PluginFrame(
      plugin,
      fileUrl,
      { t: "init", mode: "cover", reader: new URL(plugin.reader, location.origin).href, api: plugin.api, ext, width, height, theme: theme() },
      (m) => {
        if (m.t === "cover") finish({ image: m.image });
        else if (m.t === "cover-failed") finish({ failed: m.message, retry: m.retry });
        else if (m.t === "failed") finish({ failed: m.message, retry: false });
      },
    );
    const timer = setTimeout(() => finish({ failed: "the plugin took too long to draw a cover", retry: true }), COVER_MS);
    frame.element.style.cssText = "position:fixed;left:-10000px;top:0;width:" + width + "px;height:" + height + "px;border:0;visibility:hidden";
    document.body.append(frame.element);
  });
}
