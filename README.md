# Tapalog Reader

A single executable that turns a folder of books into a web library with
built-in readers. Run it, pick the folder, and open the address it prints from
any browser on your network. Nothing to install on the reading side.

Companion to [Tapalog](https://tapalog.com/) (Electronic Catalog Maker): `.ecatm`
catalogs open in the same viewer engine, [`@ecm/viewer-engine`](https://github.com/alexandrkotov/electronic-catalog-maker).

## What it does

Early, but everything below works. Each line leads to the page that describes it.

**Reading** — [guide/reading.md](guide/reading.md)
- Readers for PDF (scans too: rotate, crop, printed page numbers), EPUB, FB2, MOBI/AZW3, TXT, CBZ comics and `.ecatm` catalogs; the address always holds the exact place, so a link reproduces it
- Bookmarks, "My projects" (places and notes from several books), "Continue reading", page previews, print or save as PDF

**The library** — [guide/library.md](guide/library.md)
- A folder of books becomes a web library; books are known by their content, so renaming or moving a file keeps bookmarks, links, covers and the index
- Covers, book cards, tags, shelves; edit mode moves and renames the real files; search by name and, if turned on, inside the books
- Download a book by link, find duplicates

**Scanned books** — [guide/scans.md](guide/scans.md)
- Recognize a scanned PDF in your browser (Russian, English; nothing leaves the computer), check and correct the text beside the scan, cut figures out, make a new PDF from the result, select and copy words right on the scan, and in a book with typeset and scanned pages read only the scans

**Access and sharing** — [guide/access.md](guide/access.md)
- Accounts, share links with a QR code, internet access through a Cloudflare tunnel, backup and restore, English, Russian and Ukrainian, light and dark themes

**Plugins** — [guide/plugins.md](guide/plugins.md)
- Readers for other formats, added as a folder next to the program

One file, no installation: the web page is inside the executable. It runs on Windows, Linux and macOS.

## Run

```bash
bun install
bun run dev -- --library /path/to/books      # http://localhost:8920
```

Options: `--library`, `--port` (default 8920), `--host` (default 0.0.0.0), `--data`, `--plugins`, `--no-open`.
The chosen folder is remembered in `tapalog-reader-data/config.json`.

One program runs per data folder. Starting it a second time (a double click on the file again) finds the one that is already running, opens it in the browser and exits, instead of starting another server on the next port. If the usual ports 8920–8939 are not available (Windows keeps whole ranges of ports for itself and which ones changes from start to start), and no `--port` was given, the system picks a free one and the console says which.

Without `--library` the page asks for the folder: type its full path or press **Browse…**, which lists the folders of the computer that runs the server (drives first on Windows) with the number of books in each. The example path shown is in the style of that computer's system. The same chooser is in Settings.

To stop the program: **Settings → Stop the server** (offered to an administrator on the computer that runs it, not from the network or the internet), or Ctrl+C in its console window.

More about passwords, share links, the tunnel and a forgotten administrator password: [guide/access.md](guide/access.md#notes-on-access).

## Build the executable

```bash
bun run compile:linux-x64        # also: linux-arm64, macos-arm64, macos-x64, windows-x64
bun run compile:linux-x64:no-tunnel   # quick local build without cloudflared
```

Each `compile:*` first downloads the matching `cloudflared` release from GitHub into `vendor/` and embeds it. Output goes to `dist/`.
`bun run dev` uses `cloudflared` from `PATH` if you have it; `TUNNEL_COMMAND` (with `{url}` for the local address) and `TUNNEL_URL_PATTERN` replace it with another tunnel program.

## Releases and CI

- Every push and pull request runs `.github/workflows/ci.yml` on Linux, Windows and macOS: type check, tests, then it builds the executable for that system and starts it (`scripts/smoke.ts` checks the page, the embedded pdf.js files, the library API and a book).
- Pushing a tag such as `v0.2.0` runs `.github/workflows/release.yml`: it builds the five executables (Linux x64/arm64, macOS arm64/x64, Windows x64), packs them with the licence and creates a *draft* GitHub release with `SHA256SUMS.txt` and the notes in `.github/release-notes.md`; press Publish on the Releases page when it looks right. "Run workflow" on the Actions page builds them without publishing.
- The executables are not code-signed: Windows SmartScreen may warn on first start ("More info", "Run anyway"), and on macOS a downloaded binary needs `xattr -d com.apple.quarantine tapalog-reader-macos-*` once.

## Tests

```bash
bun run test        # unit and API tests (fast)
bun run typecheck
bun run e2e         # the real server and a real Chromium: readers, edit mode, print, share, backup
```

The browser tests need Chromium: `bunx playwright-core install chromium` once, or point `E2E_CHROMIUM` at an installed one. They build their own books in code, start the server on a free port with temporary folders, and leave nothing behind. CI runs them on Linux.

MIT licensed.
