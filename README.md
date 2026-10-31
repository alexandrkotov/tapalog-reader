# Tapalog Reader

A single executable that turns a folder of books into a web library with
built-in readers. Run it, pick the folder, and open the address it prints from
any browser on your network. Nothing to install on the reading side.

Companion to [Tapalog](https://tapalog.com/) (Electronic Catalog Maker): `.ecatm`
catalogs open in the same viewer engine, [`@ecm/viewer-engine`](https://github.com/alexandrkotov/electronic-catalog-maker).

## Status

Early. Working now:

- One-file server (Bun `--compile`), the web UI is embedded in it
- Library scan with content-based book ids (a rename or move keeps bookmarks and links valid)
- Automatic change tracking (file watcher + periodic rescan fallback)
- Collapsible tree panel, search by file name with a drop-down list, format badges
- `.ecatm` catalogs in the built-in viewer (region selection, search, PDF export)
- Range requests for book files; everything the app creates lives in `tapalog-reader-data/` next to the executable (falls back to `~/.tapalog-reader-data` if that is not writable)

Planned: readers for PDF, EPUB, FB2, DJVU, CBZ, MOBI, TXT; cover and page previews; full-text index (optional);
users with PIN/password and bookmarks; edit mode (drag and drop, rename); links and QR codes with
internet tunnels; shareable "views" (page + highlighted rectangle); print / save to PDF; backup; ru/en/uk interface.

## Run

```bash
bun install
bun run dev -- --library /path/to/books      # http://localhost:8920
```

Options: `--library`, `--port` (default 8920), `--host` (default 0.0.0.0), `--data`, `--no-open`.
The chosen folder is remembered in `tapalog-reader-data/config.json`.
Choosing or rescanning the library is limited to the computer the server runs on until accounts exist.

## Build the executable

```bash
bun run compile:linux-x64        # also: linux-arm64, macos-arm64, macos-x64, windows-x64
```

Output goes to `dist/`.

## Tests

```bash
bun test
bun run typecheck
```

MIT licensed.
