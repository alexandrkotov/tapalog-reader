import { startTunnel, type Tunnel } from "./tunnel";

export type TunnelState = "off" | "starting" | "on" | "error";

const START_TIMEOUT_MS = 45_000;

/** Starts and stops the public tunnel and remembers its address. The address changes on every start (quick tunnels are anonymous), which is why share links store only a token. */
export class TunnelController {
  state: TunnelState = "off";
  url: string | null = null;
  error: string | null = null;
  private tunnel: Tunnel | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `target` is the internal listener the tunnel forwards to, see server.ts. */
  constructor(private readonly target: () => string) {}

  private command(): string[] {
    const override = process.env.TUNNEL_COMMAND;
    const url = this.target();
    if (override) return override.split(/\s+/).map((part) => part.replaceAll("{url}", url));
    return [process.env.CLOUDFLARED_PATH ?? "cloudflared", "tunnel", "--no-autoupdate", "--url", url];
  }

  start(): void {
    if (this.tunnel) return;
    this.state = "starting";
    this.url = null;
    this.error = null;
    const pattern = process.env.TUNNEL_URL_PATTERN ? new RegExp(process.env.TUNNEL_URL_PATTERN) : undefined;
    try {
      this.tunnel = startTunnel({
        command: this.command(),
        urlPattern: pattern,
        onUrl: (url) => {
          this.clearTimer();
          this.url = url;
          this.state = "on";
        },
        onExit: (code) => {
          this.clearTimer();
          const wasStopped = this.tunnel === null;
          this.tunnel = null;
          this.url = null;
          if (wasStopped) return; // we asked for it
          this.state = "error";
          this.error = `The tunnel stopped unexpectedly (code ${code}). The public address no longer works.`;
        },
      });
    } catch {
      this.tunnel = null;
      this.state = "error";
      this.error = process.env.TUNNEL_COMMAND ? "Could not run the TUNNEL_COMMAND override." : "Could not start the tunnel: 'cloudflared' was not found.";
      return;
    }
    this.timer = setTimeout(() => {
      if (this.state !== "starting") return;
      this.stop();
      this.state = "error";
      this.error = "The tunnel did not report a public address in time. Check the internet connection and try again.";
    }, START_TIMEOUT_MS);
  }

  stop(): void {
    this.clearTimer();
    const t = this.tunnel;
    this.tunnel = null;
    this.url = null;
    this.state = "off";
    this.error = null;
    t?.stop();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
