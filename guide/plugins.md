# Plugins

[← README](../README.md) · [Reading](reading.md) · [The library](library.md) · [Scanned books](scans.md) · [Access and sharing](access.md) · [Plugins](plugins.md)

There is no built-in DJVU reader: the only JavaScript decoder, DjVu.js, is GPL v2, which does not fit this MIT project, so `.djvu` files are listed and downloadable, and a DJVU reader can be added as a plugin by whoever runs the server.

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

[`plugins-example/text-lines`](../plugins-example/text-lines) is a complete, tiny, MIT-licensed example (it shows `.lines` files, one numbered line a row).
