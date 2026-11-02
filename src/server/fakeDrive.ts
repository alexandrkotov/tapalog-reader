import type { DriveEndpoints } from "./linkImport";

export interface FakeFile {
  /** The name sent in Content-Disposition; null sends none, so the name has to come from the address. */
  name: string | null;
  content: Uint8Array<ArrayBuffer> | string;
  /** How the file is sent: chunks of this size, a pause between them (to have a download to cancel). */
  slow?: { chunk: number; everyMs: number };
  /** The content type, when it should say what the file is. */
  type?: string;
  /** No Content-Length: the size is not known until the end. */
  chunked?: boolean;
  /** Answers a request for one byte with the whole file, as many servers do. */
  ignoreRange?: boolean;
}

/**
 * A stand-in for Google Drive and for an ordinary file server, so tests never reach the real ones.
 * Drive's way: /download?id=… . Plain way: /files/<id>/<any name>. The names go out as UTF-8 bytes in a
 * header, as Google's do.
 */
export function startFakeDrive(files: Record<string, FakeFile>, picture: Uint8Array<ArrayBuffer> | null = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])) {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const plain = url.pathname.startsWith("/files/");
      const id = plain ? decodeURIComponent(url.pathname.split("/")[2] ?? "") : (url.searchParams.get("id") ?? "");
      hits.push(`${plain ? "/files" : url.pathname}?id=${id}`);
      if (url.pathname === "/thumbnail") return picture && files[id] ? new Response(null, { status: 302, headers: { Location: `/image/${id}` } }) : new Response("no", { status: 404 });
      if (url.pathname.startsWith("/image/")) return new Response(picture, { headers: { "Content-Type": "image/png" } });
      const file = files[id];
      if (id === "EVILREDIRECT") return new Response(null, { status: 302, headers: { Location: "http://example.invalid/steal" } });
      if (id === "TOMETADATA") return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } });
      if (id === "TOLOCALHOST") return new Response(null, { status: 302, headers: { Location: "http://localhost:1/inside" } });
      if (id === "LOOP") return new Response(null, { status: 302, headers: { Location: url.pathname + url.search } });
      if (id === "CLOSEDFILE") return new Response("<!doctype html><title>Sign in</title>", { headers: { "Content-Type": "text/html" } });
      if (id === "FORBIDDEN") return new Response("no", { status: 403 });
      if (!file) return new Response("<html>Error 404</html>", { status: 404, headers: { "Content-Type": "text/html" } });
      const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
      const headers: Record<string, string> = { "Content-Type": file.type ?? "application/octet-stream", "Accept-Ranges": "bytes" };
      if (file.name !== null) headers["Content-Disposition"] = `attachment; filename="${String.fromCharCode(...new TextEncoder().encode(file.name))}"`;
      if (req.headers.get("range") === "bytes=0-0" && !file.ignoreRange && !file.chunked) return new Response(bytes.slice(0, 1), { status: 206, headers: { ...headers, "Content-Range": `bytes 0-0/${bytes.length}`, "Content-Length": "1" } });
      if (!file.slow && !file.chunked) return new Response(bytes, { headers: { ...headers, "Content-Length": String(bytes.length) } });
      const { chunk, everyMs } = file.slow ?? { chunk: 500, everyMs: 1 };
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
        { headers: file.chunked ? headers : { ...headers, "Content-Length": String(bytes.length) } },
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const endpoints: DriveEndpoints = {
    download: (id) => `${origin}/download?id=${id}`,
    thumbnail: (id) => `${origin}/thumbnail?id=${id}`,
    trusted: (url) => url.origin === origin,
    local: origin,
  };
  return { origin, endpoints, hits, stop: () => server.stop(true) };
}
