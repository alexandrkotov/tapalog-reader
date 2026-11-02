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
- Page previews (**▥** in the toolbar of a PDF or a comic): a strip of small pages down the left side, drawn only as they scroll into view and one at a time, so a thousand-page book stays light. The page being read is highlighted, a click goes to a page, and the strip is remembered between visits (PDF; closed on a phone). For a comic it replaces the list of file names
- Print / save as PDF (**Print / PDF** in the reader bar; PDF, EPUB, FB2, MOBI, CBZ and TXT): choose the whole book, this page or chapter, a range of pages (PDF, comics), the marked passage (TXT) or the **highlighted area** of a PDF page, then the browser's print window opens, where "Save as PDF" as the printer writes a file. The printout is prepared in a hidden shadow tree (the book's own CSS cannot touch the app, and scripts, frames and event handlers in a book are stripped), PDF pages are drawn as ~200 dpi pictures so they look the same in every browser, and e-book text stays real, selectable text in the saved PDF. The dialog also offers the original file for download. Catalogs keep the PDF export of their own viewer
- Accounts: the first administrator is created on the computer that runs the server; readers can create their own accounts (optional, from the local network). Passwords are argon2id hashes, sessions are random cookies stored hashed, repeated failed logins are slowed down
- Share links with a QR code: `/s/<token>` opens exactly one book, optionally at an exact view, with no sign-in; a link can expire and be revoked
- Internet access through a Cloudflare quick tunnel (embedded `cloudflared`, no account or port forwarding). The tunnel enters through a separate loopback listener, so a request is known to come from the internet by the socket it arrived on, not by a header; over the tunnel the library always needs sign-in, and the first-run setup and self-registration are refused
- Download a book by link (administrator, **⬇ Download by link** in the top bar): paste the address of a file on any site (PDF, EPUB, FB2, DJVU, CBZ, MOBI, TXT) or a Google Drive share link of a file that is open to anyone with the link (a link wrapped in a Facebook redirect works too). The dialog shows the file's name in an editable field (without the extension; taken from the server's answer or the end of the address) and its size, with the cover Drive draws for it when it is a Drive link, and a choice of folder (the library's root by default), and only then downloads, with progress and a Cancel button. **The server only ever connects to addresses on the public internet**: a link into this computer or its local network (`localhost`, `192.168.x.x`, `10.x.x.x`, link-local and cloud-metadata addresses, IPv6 forms of those, numbers like `2130706433`) is refused, and the address is checked at the moment of connecting, so a name that resolves to an inside address is refused too, and so is every redirect hop. Only `http` and `https` are used, a link with a password in it is refused, and the size limit is 2 GB. The file is saved under a hidden name next to its final place, checked to be what its name claims (a web page or a different file type is thrown away), and renamed into the library only when complete, never over an existing file. **A zip archive** (a name like `book.fb2.zip` or just `book.zip`) is unpacked after it arrives: the one file in it that is a book is taken out under the name you chose, with the extension it has inside (FB2, DJVU, PDF and so on, a `readme.txt` beside the book is ignored), and the zip is not kept. A zip with no book or with several books, one that needs a password or is damaged is refused with a reason and nothing is saved; a "zip" that is really an EPUB or only pictures is kept as an EPUB or a CBZ. The unpacked book is checked against the library like any download, and it may not exceed the size limit. Drive folders, Google Docs and files of a format the library can't read are refused with a reason. Drive links rely on its public download address, not on an API key, so Google may change it. The cover in the library is drawn by the browser from the book itself, as for any other
- The same book is not saved twice: after a download the program compares what arrived with the library (by content, under any name and in any folder) and, if it is already there, says where and asks whether to keep it anyway. A file with a name already used in the folder is refused before anything is fetched.
- Finding duplicates (administrator, Settings → **Find duplicates…**): *identical files* (the same content, confirmed by reading the files whole, not only by the quick id the library keeps) and *alike names* (different files whose names are the same once case, punctuation, accents and the word copy/копия are ignored: maybe the same book in another format, maybe not). In each group of identical files one stays unchecked; the others are moved to the trash after a confirmation. The trash is the hidden folder `.tapalog-trash` inside the library (on the same disk, skipped by the scanner): nothing is deleted, and the file name keeps the original folder so a book can be moved back by hand. The last copy of a book that exists more than once is never taken, checked on the server by reading the files. Bookmarks and share links follow the content, so they keep working when one copy is removed.
- Backup and restore (administrator, in Settings; also offered on the first-run screen of a new computer): one JSON file with the accounts, bookmarks, share links and settings. Passwords are in it only as argon2id hashes, so the same passwords work after a restore, but the file should be kept private, since the share links in it are live. Books, covers and the search index are not included (they are rebuilt from the library folder) and neither is the library folder's path, which belongs to each computer. A restore replaces all accounts, bookmarks and links, signs everybody out, and keeps the administrator who did it signed in when the backup has an account of that name; a file that is not a valid backup is refused and changes nothing
- Light, dark or the system's theme (the ◐ button in the top bar, remembered in the browser; the readers follow it)
- Settings for the administrator: library folder, who may browse on the local network, internet tunnel, accounts
- Interface in English, Russian and Ukrainian
- Range requests for book files; everything the app creates lives in `tapalog-reader-data/` next to the executable (falls back to `~/.tapalog-reader-data` if that is not writable)

- Reader plugins for more formats (see [Plugins](#plugins)). There is no built-in DJVU reader: the only JavaScript decoder, DjVu.js, is GPL v2, which does not fit this MIT project, so `.djvu` files are listed and downloadable, and a DJVU reader can be added as a plugin by whoever runs the server

## Run

```bash
bun install
bun run dev -- --library /path/to/books      # http://localhost:8920
```

Options: `--library`, `--port` (default 8920), `--host` (default 0.0.0.0), `--data`, `--plugins`, `--no-open`.
The chosen folder is remembered in `tapalog-reader-data/config.json`.

Without `--library` the page asks for the folder: type its full path or press **Browse…**, which lists the folders of the computer that runs the server (drives first on Windows) with the number of books in each. The example path shown is in the style of that computer's system. The same chooser is in Settings.

To stop the program: **Settings → Stop the server** (offered to an administrator on the computer that runs it, not from the network or the internet), or Ctrl+C in its console window.

Notes on access:

- On the local network the page is plain HTTP, so a password typed there travels unencrypted inside your network. Over the internet tunnel it is HTTPS.
- Whoever has a share link can read that book: treat it like a key. Links can be limited in time and revoked under **My links**.
- A quick-tunnel address changes every time the tunnel starts, so a QR code printed from an internet link stops working after a restart. (Local-network links keep working as long as the computer's address does.)
- A forgotten administrator password: on the sign-in page (local network only) choose **Forgot the administrator password?** and ask for a code. The server writes it into `reset-code.txt` in the data folder, where only someone with access to the computer can read it; type it back with the administrator's name and a new password (fifteen minutes, one use; five wrong tries from one visitor lock that visitor out for a minute, thirty from everybody burn the code). The reset signs that account out everywhere and the file is removed. Other accounts' passwords are set by an administrator in Settings.

## Plugins

A plugin adds a reader for a format the program does not open itself (an extension that already has a built-in reader is never taken over; `.djvu`, which is listed but has no reader, can get one). It is a folder in the `plugins` folder next to the program (or the one named by `--plugins` or the `TAPALOG_PLUGINS` environment variable; **Settings → Plugins** shows where that is), read when the program starts:

```
plugins/
  my-format/
    plugin.json
    reader.js        # whatever else it needs (scripts, .wasm) can sit beside it
```

`plugin.json`:

```json
{
  "id": "my-format",
  "name": "My format reader",
  "version": "1.0.0",
  "formats": [{ "ext": ["myf", "myfile"], "mime": "application/x-my-format" }],
  "reader": "reader.js",
  "shareableView": true,
  "cover": true
}
```

- `id` is the folder's name (lower case letters, digits and hyphens). `ext` is one extension or a list; files with them join the library and the first one names the format. Two plugins cannot claim the same extension, and a plugin that cannot be understood is skipped with the reason shown in **Settings → Plugins** and in the console. `mime` is the media type the files are served with. `shareableView` says whether the reader's *view* (its place in the book) may be put into a share link. `cover` says that the module also exports `cover(context)`.
- `reader` is an ES module that exports `mount(host, context)` and returns `{ destroy, getView?, getLabel? }` (or a promise of it). `host` is an empty element to draw into; `context` has `url` (the book's file, same origin), `name`, `ext`, `view` (what `getView` returned earlier, or null), `onView(view)` (call it when the place changes), `onError(title, text)`, `theme` (`"light"` or `"dark"`) and `onTheme(fn)` (returns the way to stop). `getView` gives the place to keep in a bookmark or a share link (any JSON, small), `getLabel` a suggested bookmark name.
- `cover(context)` (optional) draws the book's cover for the library and returns a canvas, an `ImageBitmap` or an image `Blob`; `context` has `url`, `ext` and the `width` and `height` the cover is shown at (it is scaled to fit). Covers are made one at a time by the **administrator's browser** while the page is open, like those of the built-in formats, and kept per book content. Throw an error when the file has nothing to show (the book then gets a tile with its format and is not tried again); a failed `fetch` (a `TypeError`) is tried again later.
- Files of a plugin are served at `/plugins/<id>/…` to everybody who can reach the program (they have to be: a share link's page loads them too), and only files inside the plugin's own folder.
- **A plugin is code that runs in every reader's browser, on the program's own address, with the reader's login.** Install only plugins you trust, and only the person who runs the server can install one. The page's Content-Security-Policy still applies: scripts, workers and WebAssembly from the same address and `blob:`, no other sites.

[`plugins-example/text-lines`](plugins-example/text-lines) is a complete, tiny, MIT-licensed example (it shows `.lines` files, one numbered line a row).

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
