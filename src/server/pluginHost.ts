/**
 * The page an isolated plugin runs in. The program's page puts it in an <iframe sandbox="allow-scripts"> (no `allow-same-origin`):
 * the frame has an opaque origin, so it cannot read the program's cookies, its storage or its page, and its requests to the
 * program carry no login. The response is a sandbox of its own too, so that opening the address by hand gives the same.
 *
 * Because the origin is opaque the frame fetches the plugin's files as a stranger: they are served with
 * `Access-Control-Allow-Origin: *` (they hold no library data and are open anyway), and the book's bytes come from the program's
 * page by message (see pluginBridge.js).
 */
export const PLUGIN_HOST_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src blob:",
  "connect-src 'self' blob: data:",
  "worker-src blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

export const PLUGIN_HOST_PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Plugin</title>
    <style>
      html, body { margin: 0; height: 100%; }
    </style>
  </head>
  <body>
    <script src="/plugin-host/bridge.js"></script>
  </body>
</html>
`;
