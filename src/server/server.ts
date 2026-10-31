import { join, sep } from "node:path";
import type { Server } from "bun";
import { MIME, type Format } from "./formats";
import type { Library } from "./library";
import index from "../web/index.html";
import { PDFJS_ASSETS } from "./pdfjsAssets.generated";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Admin-only actions are limited to the machine the app runs on until real accounts exist. */
function isLocal(server: Server<unknown>, req: Request): boolean {
  const ip = server.requestIP(req)?.address ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Serves one book file, honouring a single `Range` so readers can fetch big PDFs in pieces. */
function serveFile(absPath: string, mime: string, rangeHeader: string | null, fileName: string): Response {
  const file = Bun.file(absPath);
  const size = file.size;
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2])); // "-N": the last N bytes
      end = size - 1;
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
}

const ASSET_TYPES: Record<string, string> = {
  mjs: "text/javascript",
  wasm: "application/wasm",
  ttf: "font/ttf",
};

/** The runtime files pdf.js loads itself: worker, image decoders, fonts, CMaps (see scripts/gen-pdfjs-assets.ts). */
function servePdfjsAsset(req: Request): Response {
  const name = decodeURIComponent(new URL(req.url).pathname.slice("/pdfjs/".length));
  const path = Object.hasOwn(PDFJS_ASSETS, name) ? PDFJS_ASSETS[name] : undefined; // a fixed list: no path from the request reaches the disk
  if (!path) return new Response("Not found", { status: 404 });
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return new Response(Bun.file(path), {
    headers: { "Content-Type": ASSET_TYPES[ext] ?? "application/octet-stream", "Cache-Control": "public, max-age=86400" },
  });
}

export function startServer(library: Library, opts: { hostname: string; port: number }): Server<unknown> {
  const server: Server<unknown> = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    routes: {
      "/": index,
      "/pdfjs/*": servePdfjsAsset,
      "/api/status": () =>
        json({
          libraryPath: library.root,
          books: library.count(),
          scanning: library.scanning,
          lastScan: library.lastScan,
        }),
      "/api/library": () => json({ folders: library.folders(), books: library.books() }),
      "/api/search": (req) => {
        const q = new URL(req.url).searchParams.get("q") ?? "";
        return json({ books: library.searchNames(q) });
      },
      "/api/file/:id": (req) => {
        // Only ids from our own index map to a path: there is no way to name an arbitrary file.
        const book = library.byId(req.params.id);
        const root = library.root;
        if (!book || !root) return new Response("Not found", { status: 404 });
        const abs = join(root, ...book.path.split("/"));
        const fileName = book.path.slice(book.path.lastIndexOf("/") + 1);
        return serveFile(abs, MIME[book.ext as Format] ?? "application/octet-stream", req.headers.get("range"), fileName);
      },
      "/api/rescan": {
        POST: async (req) => {
          if (!isLocal(server, req)) return json({ error: "admin only" }, 403);
          void library.rescan();
          return json({ ok: true });
        },
      },
      "/api/library/path": {
        POST: async (req) => {
          if (!isLocal(server, req)) return json({ error: "admin only" }, 403);
          const body = (await req.json().catch(() => null)) as { path?: string } | null;
          if (!body?.path) return json({ error: "path required" }, 400);
          try {
            await library.setRoot(body.path);
            return json({ ok: true });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  return server;
}
