/**
 * Runs the subprocess that makes this server reachable from the internet:
 * by default `cloudflared tunnel --url ...`, Cloudflare's free "quick tunnel"
 * (no account, no port-forwarding, real HTTPS). It prints a one-off
 * `https://*.trycloudflare.com` address, which is all this module watches for.
 *
 * Not hard-wired to Cloudflare: the caller supplies the command and the URL
 * pattern (see tunnelController.ts: TUNNEL_COMMAND / TUNNEL_URL_PATTERN), since
 * the anonymous mode has no uptime guarantee. Adapted from Tapalog's
 * Catalog Server (MIT).
 */

const DEFAULT_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Pulled out as its own function so the parsing logic is unit-testable against real captured cloudflared output, without spawning the actual binary. */
export function extractTunnelUrl(line: string, pattern: RegExp = DEFAULT_TUNNEL_URL_PATTERN): string | null {
  return line.match(pattern)?.[0] ?? null;
}

export interface Tunnel {
  stop(): void;
}

export interface StartTunnelOptions {
  /** Full argv to spawn, e.g. `[cloudflaredPath, "tunnel", "--url", "http://localhost:8787"]` — built by the caller, since only it knows what port/path/provider apply. */
  command: string[];
  /** How to recognize the public URL in the subprocess's output — defaults to cloudflared's own `*.trycloudflare.com` pattern. Override when `command` points at a different tunnel provider. */
  urlPattern?: RegExp;
  onUrl: (url: string) => void;
  /** Every line of the subprocess's combined output, mainly for a verbose/debug mode — most callers don't need this. */
  onLog?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

export function startTunnel(opts: StartTunnelOptions): Tunnel {
  const pattern = opts.urlPattern ?? DEFAULT_TUNNEL_URL_PATTERN;
  const proc = Bun.spawn(opts.command, {
    stdout: "pipe",
    stderr: "pipe",
    // Without this, Windows pops up its own console window for this
    // subprocess regardless of --windows-hide-console on *our* binary —
    // that flag only covers our own process, and cloudflared.exe is a
    // console-subsystem app Windows gives a fresh console to when spawned
    // from a console-less parent. Confirmed live on Windows: an empty
    // console window (its stdout/stderr are piped here, not inherited, so
    // there was never anything visible in it anyway) opened right
    // alongside the status page until this was added.
    windowsHide: true,
  });

  let found = false;
  async function watch(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        opts.onLog?.(line);
        if (!found) {
          const url = extractTunnelUrl(line, pattern);
          if (url) {
            found = true;
            opts.onUrl(url);
          }
        }
      }
    }
  }

  void watch(proc.stdout as ReadableStream<Uint8Array> | null);
  void watch(proc.stderr as ReadableStream<Uint8Array> | null);
  void proc.exited.then((code) => opts.onExit?.(code));

  return {
    stop() {
      proc.kill();
    },
  };
}
