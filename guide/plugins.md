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
  "api": 1,
  "formats": [{ "ext": ["myf", "myfile"], "mime": "application/x-my-format" }],
  "reader": "reader.js",
  "shareableView": true,
  "cover": true
}
```

- `api` is the version of the contract between the program and plugins that the plugin was written for (a whole number; 1 when it is left out). The program says which one it gives in **Settings → Plugins**. A plugin written for a newer one than the program's is skipped, with the reason shown there, instead of failing in somebody's reader. The number stays the same when the program only adds something (a new field in `context`, an optional export), so a plugin written for 1 goes on working; it is raised only for a change that could break such a plugin, and the program then keeps giving the old behaviour to plugins that name the old number for as long as it can. This program gives 2, which adds *isolated* plugins (see below); a plugin written for 1 runs in the page as it always did.
- `id` is the folder's name (lower case letters, digits and hyphens). `ext` is one extension or a list; files with them join the library and the first one names the format. Two plugins cannot claim the same extension, and a plugin that cannot be understood is skipped with the reason shown in **Settings → Plugins** and in the console. `mime` is the media type the files are served with. `shareableView` says whether the reader's *view* (its place in the book) may be put into a share link. `cover` says that the module also exports `cover(context)`.
- `reader` is an ES module that exports `mount(host, context)` and returns `{ destroy, getView?, getLabel? }` (or a promise of it). `host` is an empty element to draw into; `context` has `api` (the version of the contract it is given: its own `api`), `url` (the book's file, same origin), `name`, `ext`, `view` (what `getView` returned earlier, or null), `onView(view)` (call it when the place changes), `onError(title, text)`, `theme` (`"light"` or `"dark"`) and `onTheme(fn)` (returns the way to stop). `getView` gives the place to keep in a bookmark or a share link (any JSON, small), `getLabel` a suggested bookmark name.
- `cover(context)` (optional) draws the book's cover for the library and returns a canvas, an `ImageBitmap` or an image `Blob`; `context` has `api`, `url`, `ext` and the `width` and `height` the cover is shown at (it is scaled to fit). Covers are made one at a time by the **administrator's browser** while the page is open, like those of the built-in formats, and kept per book content. Throw an error when the file has nothing to show (the book then gets a tile with its format and is not tried again); a failed `fetch` (a `TypeError`) is tried again later.
- Files of a plugin are served at `/plugins/<id>/…` to everybody who can reach the program (they have to be: a share link's page loads them too), and only files inside the plugin's own folder.
- **A plugin is code that runs in every reader's browser, on the program's own address, with the reader's login.** Install only plugins you trust, and only the person who runs the server can install one. The page's Content-Security-Policy still applies: scripts, workers and WebAssembly from the same address and `blob:`, no other sites. (A plugin that asks to be isolated, below, is held to much less.)

## Isolated plugins (API 2)

A plugin written as above runs in the page, so it can do whatever the page can. A plugin you trust less, or that comes from somebody else, can be held to less: it asks to be **isolated** with `"api": 2` and `"isolated": true` in `plugin.json` (isolated needs api 2; a plugin that says isolated for api 1 is skipped, with the reason). Its reader then runs in a frame of its own, `<iframe sandbox="allow-scripts">`, which the program serves at `/plugin-host/<id>` with a policy that says the same, so the frame is sandboxed even if the attribute were changed. Such a plugin:

- **cannot** read the program's cookies, its storage or its page, act with the reader's login, open windows, navigate the page away, or reach any site other than the program's own address, where it is a stranger without a login and cannot read the answers;
- is given the book's bytes by message instead of an address: `await context.file()` returns an `ArrayBuffer` (a new copy each time), and there is no `context.url`;
- draws into `host`, which is the body of its own document. `context` has `api`, `name`, `ext`, `view`, `theme`, `onTheme(fn)`, `onView(view)`, `onError(title, text)` and `file()`, and nothing else. `mount` returns `{ destroy, getView?, getLabel? }` as before; the program keeps the last place reported with `onView` and also asks `getView` and `getLabel` twice a second, because it cannot ask a frame at the moment a place is saved. A view must be plain JSON;
- has `cover(context)` too, with `file()` in place of `url`: the cover is drawn in a hidden frame that is closed afterwards, and a canvas is turned into an image on its way back. A `TypeError` (a failed `file()`) is tried again later, as for plugins in the page;
- has no `localStorage` or cookies (they throw): what should be remembered goes into the place it reports. It may use WebAssembly and workers started from `blob:` (to start a worker, `fetch` its script from the plugin's own folder, wrap it in a `Blob` and use `URL.createObjectURL`; the plugin's files and the program's script for the frame are served with `Access-Control-Allow-Origin: *`, which a frame without an origin needs, and hold no library data).

Isolation limits what a plugin can do to the program and to the reader's login, not what it shows: it still reads the book it opens and draws whatever it likes in its frame. To move a plugin that runs in the page: read the file with `context.file()` instead of fetching `context.url`, touch only `host` (the document is its own), drop storage, and set `"api": 2, "isolated": true`. A plugin may also stay in the page when it needs what a frame cannot give, such as the page's styles.

[`plugins-example/text-lines`](../plugins-example/text-lines) is a complete, tiny, MIT-licensed example (it shows `.lines` files, one numbered line a row), and [`plugins-example/text-lines-sandboxed`](../plugins-example/text-lines-sandboxed) is the same as an isolated plugin (`.slines` files).
