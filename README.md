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
- Cover previews for PDF, EPUB, FB2, MOBI, CBZ and `.ecatm` (TXT shows a format tile). Folders open as a shelf of covers (click a folder's name, or the title to go back to the library root), and search results show thumbnails. Covers are drawn by the **administrator's browser** (pdf.js, the book engine) and uploaded as small JPEGs, because the server has no image decoder; they are made while an administrator has the page open, one at a time, and kept per book content (a rename or move keeps them). Catalog covers are read on the server with the viewer engine. A comic larger than 300 MB gets no cover, and covers of books gone for 30 days are removed
- Search inside books (optional, off by default; the administrator turns it on in Settings): PDF text, EPUB, FB2 (any encoding), MOBI, TXT and catalog texts are read in the background, one book at a time, into a SQLite FTS5 index (`fulltext.db`, roughly as large as the text itself). Words are matched case- and accent-insensitively and the last word may be unfinished. Results appear in the search box under "Inside books" with a snippet and open the book at the place: the PDF page, the catalog picture and hotspot, the marked word in a TXT, the chapter of an EPUB, and roughly the right spot (a fraction of the book) for FB2 and MOBI. Scans have no text layer, so there is nothing to find in them (no OCR). A book is read once per content, so renames and moves cost nothing; the index of books gone for 30 days is dropped
- Bookmarks per reader: **★ Bookmarks** in the reader bar saves the current place (PDF page, catalog view, EPUB/FB2/MOBI position, TXT line, with its marked passage) under a name that is suggested from the place (a page number, the chapter), and **My bookmarks** lists them all across books. They are stored on the server under the reader's account, so they follow the reader to any device, and they are keyed by book content, so renaming or moving a book keeps them. A visitor without an account who clicks the button is offered to sign in or create one (when registration is allowed)
- Edit mode (administrator only, **✎ Edit** in the top bar): drag books and folders in the tree, or the covers of a shelf, into any folder or onto the "Library" row to move them; ✎ (or a double click) renames, ⇄ moves through a list of folders (for phones and keyboards); **＋ New folder** makes arbitrary hierarchies. Changes are made to the **real files and folders** in the library folder, so they show up in the file manager too; nothing is ever overwritten (a name already taken is refused), a rename keeps the file extension, and there is no delete. The library must be writable, otherwise the button is disabled. Because book ids come from the content, bookmarks, share links, covers and the search index all survive a move or rename
- Print / save as PDF (**Print / PDF** in the reader bar; PDF, EPUB, FB2, MOBI, CBZ and TXT): choose the whole book, this page or chapter, a range of pages (PDF, comics), the marked passage (TXT) or the **highlighted area** of a PDF page, then the browser's print window opens, where "Save as PDF" as the printer writes a file. The printout is prepared in a hidden shadow tree (the book's own CSS cannot touch the app, and scripts, frames and event handlers in a book are stripped), PDF pages are drawn as ~200 dpi pictures so they look the same in every browser, and e-book text stays real, selectable text in the saved PDF. The dialog also offers the original file for download. Catalogs keep the PDF export of their own viewer
- Accounts: the first administrator is created on the computer that runs the server; readers can create their own accounts (optional, from the local network). Passwords are argon2id hashes, sessions are random cookies stored hashed, repeated failed logins are slowed down
- Share links with a QR code: `/s/<token>` opens exactly one book, optionally at an exact view, with no sign-in; a link can expire and be revoked
- Internet access through a Cloudflare quick tunnel (embedded `cloudflared`, no account or port forwarding). The tunnel enters through a separate loopback listener, so a request is known to come from the internet by the socket it arrived on, not by a header; over the tunnel the library always needs sign-in, and the first-run setup and self-registration are refused
- Settings for the administrator: library folder, who may browse on the local network, internet tunnel, accounts
- Interface in English, Russian and Ukrainian
- Range requests for book files; everything the app creates lives in `tapalog-reader-data/` next to the executable (falls back to `~/.tapalog-reader-data` if that is not writable)

Planned: DJVU reader (the only JS decoder, DjVu.js, is GPL v2+, which does not fit MIT, so it is postponed; `.djvu` files are listed and downloadable meanwhile); page previews inside the readers;
backup.

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
