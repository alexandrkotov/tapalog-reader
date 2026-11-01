import type { DriveEndpoints } from "./driveImport";

export interface FakeFile {
  name: string;
  content: Uint8Array<ArrayBuffer> | string;
  /** How the file is sent: chunks of this size, a pause between them (to have a download to cancel). */
  slow?: { chunk: number; everyMs: number };
}

/** A stand-in for Google Drive, so tests never reach the real one. The names go out as UTF-8 bytes in a header, as Google's do. */
export function startFakeDrive(files: Record<string, FakeFile>, picture: Uint8Array<ArrayBuffer> | null = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])) {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const id = url.searchParams.get("id") ?? "";
      hits.push(`${url.pathname}?id=${id}`);
      if (url.pathname === "/thumbnail") return picture && files[id] ? new Response(null, { status: 302, headers: { Location: `/image/${id}` } }) : new Response("no", { status: 404 });
      if (url.pathname.startsWith("/image/")) return new Response(picture, { headers: { "Content-Type": "image/png" } });
      const file = files[id];
      if (id === "EVILREDIRECT") return new Response(null, { status: 302, headers: { Location: "http://example.invalid/steal" } });
      if (id === "CLOSEDFILE") return new Response("<!doctype html><title>Sign in</title>", { headers: { "Content-Type": "text/html" } });
      if (!file) return new Response("<html>Error 404</html>", { status: 404, headers: { "Content-Type": "text/html" } });
      const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
      const name = String.fromCharCode(...new TextEncoder().encode(file.name));
      const headers = { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`, "Accept-Ranges": "bytes" };
      if (req.headers.get("range") === "bytes=0-0") return new Response(bytes.slice(0, 1), { status: 206, headers: { ...headers, "Content-Range": `bytes 0-0/${bytes.length}`, "Content-Length": "1" } });
      if (!file.slow) return new Response(bytes, { headers: { ...headers, "Content-Length": String(bytes.length) } });
      const { chunk, everyMs } = file.slow;
      let at = 0;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            if (at >= bytes.length) return controller.close();
            await Bun.sleep(everyMs);
            controller.enqueue(bytes.slice(at, at + chunk));
            at += chunk;
          },
        }),
        { headers: { ...headers, "Content-Length": String(bytes.length) } },
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const endpoints: DriveEndpoints = {
    download: (id) => `${origin}/download?id=${id}`,
    thumbnail: (id) => `${origin}/thumbnail?id=${id}`,
    trusted: (url) => url.origin === origin,
  };
  return { origin, endpoints, hits, stop: () => server.stop(true) };
}
