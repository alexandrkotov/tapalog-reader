/**
 * Entry point of the darwin-arm64 build only: embeds the real cloudflared binary
 * (fetched into vendor/ by scripts/fetch-cloudflared.ts right before compiling)
 * in the single-file executable, so nobody has to install it. See
 * embedCloudflared.ts for why it is copied out to a temp file at start.
 * `bun run dev` never imports this file and uses cloudflared from PATH, if any.
 */
import { extractEmbeddedBinary } from "./embedCloudflared";
import cloudflaredEmbedded from "../../vendor/cloudflared-darwin-arm64" with { type: "file" };

process.env.CLOUDFLARED_PATH ??= await extractEmbeddedBinary(cloudflaredEmbedded, "tapalog-reader-cloudflared");
await import("./main");
