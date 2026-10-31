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
- PDF reader (pdf.js, loaded on demand; works for scans too: JBIG2/JPEG 2000 decoders, fonts and CMaps are embedded). The address bar always holds the current *view*: page, position, zoom and an optional highlighted rectangle drawn with **Area**; the same link reproduces it in a window of any size
- EPUB, FB2 and MOBI/AZW3 reader and a CBZ comic viewer ([foliate-js](https://github.com/johnfactotum/foliate-js), MIT, loaded on demand): contents, pages or continuous scroll, text size, arrow keys. A passage selected with **Mark** is highlighted, and the address bar holds the position and the mark (as EPUB CFIs, so they survive another window or text size). Books are third-party content: the page's Content-Security-Policy stops scripts and inline handlers inside an EPUB from running, and links in a book open only if they are http(s) or mailto
- TXT reader: encoding detected automatically (UTF-8, UTF-16 with BOM, Windows-1251, Windows-1252), text size, **Mark** a passage; the address bar holds the top line and the mark as character offsets, so a link reproduces them in any window
- Accounts: the first administrator is created on the computer that runs the server; readers can create their own accounts (optional, from the local network). Passwords are argon2id hashes, sessions are random cookies stored hashed, repeated failed logins are slowed down
- Share links with a QR code: `/s/<token>` opens exactly one book, optionally at an exact view, with no sign-in; a link can expire and be revoked
- Internet access through a Cloudflare quick tunnel (embedded `cloudflared`, no account or port forwarding). The tunnel enters through a separate loopback listener, so a request is known to come from the internet by the socket it arrived on, not by a header; over the tunnel the library always needs sign-in, and the first-run setup and self-registration are refused
- Settings for the administrator: library folder, who may browse on the local network, internet tunnel, accounts
- Interface in English, Russian and Ukrainian
- Range requests for book files; everything the app creates lives in `tapalog-reader-data/` next to the executable (falls back to `~/.tapalog-reader-data` if that is not writable)

Planned: DJVU reader (the only JS decoder, DjVu.js, is GPL v2+, which does not fit MIT, so it is postponed; `.djvu` files are listed and downloadable meanwhile); cover and page previews; full-text index (optional);
bookmarks per user; edit mode (drag and drop, rename); print / save to PDF; backup.

## Run

```bash
bun install
bun run dev -- --library /path/to/books      # http://localhost:8920
```

Options: `--library`, `--port` (default 8920), `--host` (default 0.0.0.0), `--data`, `--no-open`.
The chosen folder is remembered in `tapalog-reader-data/config.json`.

Notes on access:

- On the local network the page is plain HTTP, so a password typed there travels unencrypted inside your network. Over the internet tunnel it is HTTPS.
- Whoever has a share link can read that book: treat it like a key. Links can be limited in time and revoked under **My links**.
- A quick-tunnel address changes every time the tunnel starts, so a QR code printed from an internet link stops working after a restart. (Local-network links keep working as long as the computer's address does.)
- There is no password recovery yet: an administrator can set any account's password, but the last administrator's password can't be reset from the page.

## Build the executable

```bash
bun run compile:linux-x64        # also: linux-arm64, macos-arm64, macos-x64, windows-x64
bun run compile:linux-x64:no-tunnel   # quick local build without cloudflared
```

Each `compile:*` first downloads the matching `cloudflared` release from GitHub into `vendor/` and embeds it. Output goes to `dist/`.
`bun run dev` uses `cloudflared` from `PATH` if you have it; `TUNNEL_COMMAND` (with `{url}` for the local address) and `TUNNEL_URL_PATTERN` replace it with another tunnel program.

## Tests

```bash
bun test
bun run typecheck
```

MIT licensed.
