import { join } from "node:path";
import type { Server } from "bun";
import type { Auth, User } from "./auth";
import { validateName, validatePassword } from "./auth";
import { BackupError, parseBackup, type Backup, type BackupFile } from "./backup";
import type { Bookmarks } from "./bookmarks";
import { effective, MetaError, shelfFields } from "./bookmeta";
import { parseDisplay, type DisplayStore } from "./display";
import type { ProgressStore } from "./progress";
import { ProjectError, type ProjectItem, type Projects } from "./projects";
import type { ConfigStore } from "./config";
import { COVER_FORMATS, MAX_COVER_BYTES, type Covers } from "./covers";
import { BrowseError, browse as listFolders } from "./browse";
import { findDuplicates } from "./duplicates";
import { SourceError, type Sources } from "./sources";
import { ImportError, isFileId, type LinkImports } from "./linkImport";
import { EditError, type LibraryEditor } from "./editor";
import { ecatmCover } from "./ecatmCover";
import type { FullText } from "./fulltext";
import { mimeOf } from "./formats";
import { APP_NAME, PING } from "./instance";
import { Plugins } from "./plugins";
import type { BookRow, Library } from "./library";
import { OCR_ASSETS } from "./ocrAssets.generated";
import { PDFJS_ASSETS } from "./pdfjsAssets.generated";
import { RESET_FILE, type Recovery } from "./recovery";
import type { Shares } from "./shares";
import type { TunnelController } from "./tunnelController";
import index from "../web/index.html";
import { COMPONENTS, REPO_URL, SITE_URL, VERSION } from "./about";
import { MAX_PAGES, validLang } from "./ocr";

export interface App {
  library: Library;
  auth: Auth;
  recovery: Recovery;
  shares: Shares;
  config: ConfigStore;
  covers: Covers;
  bookmarks: Bookmarks;
  progress: ProgressStore;
  projects: Projects;
  display: DisplayStore;
  backup: Backup;
  sources: Sources;
  plugins: Plugins;
  editor: LibraryEditor;
  linkImports: LinkImports;
  fullText: FullText;
  tunnel: TunnelController;
  /** Addresses of this computer on the local network, for share links. */
  lanUrls(): string[];
  /** Persists the mode and starts or stops the tunnel. */
  setMode(mode: "lan" | "internet"): void;
  /** Shuts the whole program down. */
  stop(): void;
}

export interface Servers {
  lan: Server<unknown>;
  /** Loopback-only listener the tunnel forwards to. */
  internal: Server<unknown>;
  stop(): void;
}

/**
 * Where a request came from. The tunnel is pointed at a separate loopback
 * listener, so "came through the internet" is decided by *which socket
 * accepted it*, never by a header a visitor could forge. (A tunnel's requests
 * all arrive from 127.0.0.1, so the peer address alone can't tell them apart
 * from a person sitting at the computer.)
 */
type Origin = "lan" | "tunnel";

const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });
const notFound = () => new Response("Not found", { status: 404 });

/** Serves one book file, honouring a single `Range` so readers can fetch big PDFs in pieces. */
function serveFile(absPath: string, mime: string, rangeHeader: string | null, fileName: string): Response {
  const file = Bun.file(absPath);
  const size = file.size;
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2])); // "-N": the last N bytes
      end = size - 1;
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
}

const ASSET_TYPES: Record<string, string> = { mjs: "text/javascript", wasm: "application/wasm", ttf: "font/ttf" };

/** The runtime files pdf.js loads itself: worker, image decoders, fonts, CMaps (see scripts/gen-pdfjs-assets.ts). */
function servePdfjsAsset(req: Request): Response {
  const name = decodeURIComponent(new URL(req.url).pathname.slice("/pdfjs/".length));
  const path = Object.hasOwn(PDFJS_ASSETS, name) ? PDFJS_ASSETS[name] : undefined; // a fixed list: no path from the request reaches the disk
  if (!path) return notFound();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return new Response(Bun.file(path), { headers: { "Content-Type": ASSET_TYPES[ext] ?? "application/octet-stream", "Cache-Control": "public, max-age=86400" } });
}

/** The engine that reads the pictures of scanned pages: script, worker, core and language data (see scripts/gen-ocr-assets.ts). */
function serveOcrAsset(req: Request): Response {
  const name = decodeURIComponent(new URL(req.url).pathname.slice("/ocr/".length));
  const path = Object.hasOwn(OCR_ASSETS, name) ? OCR_ASSETS[name] : undefined; // a fixed list again
  if (!path) return notFound();
  const type = name.endsWith(".js") ? "text/javascript" : "application/octet-stream";
  return new Response(Bun.file(path), { headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400" } });
}

const param = (req: Bun.BunRequest, name: string) => req.params[name] ?? "";
const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

type Handler = (req: Bun.BunRequest, server: Server<unknown>) => Response | Promise<Response>;

function buildRoutes(app: App, origin: Origin) {
  const withCover = <T extends { id: string }>(b: T) => (app.covers.has(b.id) ? { ...b, cover: true } : b);
  /** A list of books as the shelf shows it: with the cover flag and the title, authors, year, series and tags the card holds. */
  const shelf = <T extends { id: string; name: string }>(books: T[]) => {
    const meta = app.library.meta.all();
    return books.map((b) => ({ ...withCover(b), ...shelfFields(meta.get(b.id), b.name) }));
  };
  /** A book's card: what the library shows, what the file itself says, which fields were typed by hand, and where the file lies. */
  const cardOf = (book: BookRow) => {
    const row = app.library.meta.row(book.id);
    return {
      id: book.id,
      name: book.name,
      path: book.path,
      ext: book.ext,
      size: book.size,
      copies: app.library.pathsWithId(book.id),
      fields: effective(row?.manual ?? {}, row?.auto ?? {}),
      auto: row?.auto ?? {},
      edited: Object.keys(row?.manual ?? {}),
    };
  };
  /** A whole number from the address, kept between 1 and `max`, or `fallback`. */
  const count = (url: URL, name: string, fallback: number, max: number) => {
    const n = Number(url.searchParams.get(name));
    return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
  };
  /** The filters of the page of search results (format, tag, part of an author's name), as a test of a book; none when none was asked. */
  const filterOf = (url: URL): ((book: BookRow) => boolean) | undefined => {
    const format = url.searchParams.get("format") ?? "";
    const tag = (url.searchParams.get("tag") ?? "").toLowerCase();
    const author = (url.searchParams.get("author") ?? "").trim().toLowerCase();
    if (!format && !tag && !author) return undefined;
    const meta = app.library.meta.all();
    return (book) => {
      const fields = shelfFields(meta.get(book.id), book.name);
      return (!format || book.ext === format) && (!tag || fields.tags.some((x) => x.toLowerCase() === tag)) && (!author || fields.authors.some((a) => a.toLowerCase().includes(author)));
    };
  };
  const secureCookie = origin === "tunnel"; // the tunnel always speaks https to the visitor
  const user = (req: Request): User | null => app.auth.userFor(req);
  const canBrowse = (req: Request) => user(req) !== null || (origin === "lan" && app.config.get().lanAccess === "open");
  const clientIp = (req: Request, server: Server<unknown>) =>
    origin === "tunnel" ? (req.headers.get("cf-connecting-ip") ?? "tunnel") : (server.requestIP(req)?.address ?? "?"); // the header is trustworthy here: only the tunnel process reaches this socket

  const unauthorized = () => json({ error: "sign-in required" }, 401);
  const forbidden = () => json({ error: "forbidden" }, 403);

  /** Browsing the library: a signed-in user, or anyone on the local network when the admin left it open. */
  const browse = (handler: Handler): Handler => (req, server) => (canBrowse(req) ? handler(req, server) : unauthorized());
  const admin = (handler: (req: Bun.BunRequest, server: Server<unknown>, me: User) => Response | Promise<Response>): Handler => (req, server) => {
    const me = user(req);
    if (!me) return unauthorized();
    return me.role === "admin" ? handler(req, server, me) : forbidden();
  };

  const sameOrigin = (req: Request): boolean => {
    const originHeader = req.headers.get("origin");
    if (!originHeader) return true;
    try {
      return new URL(originHeader).host === req.headers.get("host");
    } catch {
      return false;
    }
  };

  /** State-changing requests must be JSON from our own pages: a cross-site form post can't send that. */
  async function body(req: Request): Promise<Record<string, unknown> | null> {
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
    if (!sameOrigin(req)) return null;
    const data = await req.json().catch(() => null);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  }
  const bad = (message = "bad request") => json({ error: message }, 400);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const wholeNumber = (v: string) => (/^\d{1,15}$/.test(v) ? Number(v) : -1); // -1 names nothing
  /** What a list shows for a book: the title of its card, or the file's name when it has none. */
  const titleOf = (book: { id: string; name: string }) => shelfFields(app.library.meta.row(book.id) ?? undefined, book.name).title;
  /** A project item with what the page needs to show its book; a book that left the library is marked, and the item keeps its notes and quote. */
  const withBook = (item: ProjectItem) => {
    const info = item.bookId ? app.library.byId(item.bookId) : null;
    return { ...item, book: info ? { name: info.name, title: titleOf(info), ext: info.ext, path: info.path } : null, missing: item.bookId !== null && !info };
  };

  /** Runs one library edit; a refused edit answers with a short code the page turns into words. */
  async function edit(req: Request, change: (data: Record<string, unknown>) => void): Promise<Response> {
    const data = await body(req);
    if (!data) return bad();
    try {
      change(data);
      return json({ ok: true });
    } catch (err) {
      if (err instanceof EditError) return bad(err.code);
      throw err;
    }
  }

  /** A refused import answers with a short code the page turns into words. */
  async function importing(run: () => Promise<Response>): Promise<Response> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ImportError || err instanceof EditError) return bad(err.code);
      throw err;
    }
  }

  /** Replaces accounts, bookmarks, links and settings with a backup's. A refused file answers with a short code and changes nothing. */
  async function restore(req: Request): Promise<{ done: { users: number; bookmarks: number; shares: number } } | Response> {
    const data = await body(req);
    if (!data) return bad();
    let file: BackupFile;
    try {
      file = parseBackup(data);
    } catch (err) {
      if (err instanceof BackupError) return bad(err.code);
      throw err;
    }
    const done = app.backup.restore(file);
    const { lanAccess, allowRegistration, mode, fullText } = file.settings;
    app.config.update({ lanAccess, allowRegistration });
    if (app.config.get().fullText !== fullText) app.fullText.setEnabled(fullText);
    if (app.config.get().mode !== mode) app.setMode(mode);
    return { done };
  }

  async function signIn(me: User): Promise<Response> {
    const session = app.auth.startSession(me.id);
    return json({ user: me }, 200, { "Set-Cookie": app.auth.sessionCookie(session.token, session.maxAgeSeconds, secureCookie) });
  }

  const settingsView = () => ({
    libraryPath: app.library.root,
    lanAccess: app.config.get().lanAccess,
    allowRegistration: app.config.get().allowRegistration,
    mode: app.config.get().mode,
    tunnel: { state: app.tunnel.state, url: app.tunnel.url, error: app.tunnel.error },
    users: app.auth.listUsers(),
  });

  const routes: Record<string, unknown> = {
    "/": index,
    "/s/:token": index,
    "/pdfjs/*": servePdfjsAsset,
    "/ocr/*": serveOcrAsset, // open like /pdfjs/*: no library data in it
    // files of the installed plugins: readers and what they load. Open like /pdfjs/*, because the page of a share link needs them too and they hold no library data
    "/plugins/*": (req: Request) => {
      const [, , id = "", ...rest] = new URL(req.url).pathname.split("/");
      let found: ReturnType<Plugins["file"]> = null;
      try {
        found = app.plugins.file(decodeURIComponent(id), rest.map(decodeURIComponent));
      } catch {
        /* a broken escape in the address: not found */
      }
      return found ? new Response(Bun.file(found.path), { headers: { "Content-Type": found.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" } }) : notFound();
    },
    "/api/plugins": () => json({ plugins: app.plugins.describe() }),
    "/api/admin/plugins": { GET: admin(() => json({ dir: app.plugins.dir, plugins: app.plugins.describe(), problems: app.plugins.problems })) },

    // ----- who am I -----
    "/api/me": (req: Request, server: Server<unknown>) => {
      const me = user(req);
      const noUsers = app.auth.userCount() === 0;
      return json({
        user: me,
        origin,
        canBrowse: canBrowse(req),
        lanAccess: app.config.get().lanAccess,
        setupNeeded: noUsers,
        setupPossible: noUsers && origin === "lan" && isLoopback(server.requestIP(req)?.address ?? ""),
        canRegister: origin === "lan" && app.config.get().allowRegistration && !noUsers,
        canRecover: origin === "lan" && !noUsers,
        canStop: origin === "lan" && isLoopback(server.requestIP(req)?.address ?? ""), // the program can be stopped from the computer it runs on, not from afar
      });
    },
    "/api/setup": {
      POST: async (req: Request, server: Server<unknown>) => {
        const data = await body(req);
        const name = validateName(data?.name);
        const password = validatePassword(data?.password);
        if (!name || !password) return bad("name or password too short");
        // The first administrator can only be created from the computer that runs the server.
        if (origin !== "lan" || !isLoopback(server.requestIP(req)?.address ?? "") || app.auth.userCount() > 0) return forbidden();
        return signIn(await app.auth.createUser(name, password, "admin"));
      },
    },
    // a new computer: bring the accounts and settings of an old installation instead of creating a first administrator
    "/api/setup/restore": {
      POST: async (req: Request, server: Server<unknown>) => {
        if (origin !== "lan" || !isLoopback(server.requestIP(req)?.address ?? "") || app.auth.userCount() > 0) return forbidden();
        const result = await restore(req);
        return result instanceof Response ? result : json({ ok: true, ...result.done });
      },
    },
    "/api/register": {
      POST: async (req: Request) => {
        const data = await body(req);
        const name = validateName(data?.name);
        const password = validatePassword(data?.password);
        if (!name || !password) return bad("name or password too short");
        if (origin !== "lan" || !app.config.get().allowRegistration || app.auth.userCount() === 0) return forbidden();
        try {
          return signIn(await app.auth.createUser(name, password, "user"));
        } catch {
          return json({ error: "name taken" }, 409);
        }
      },
    },
    "/api/login": {
      POST: async (req: Request, server: Server<unknown>) => {
        const data = await body(req);
        const name = typeof data?.name === "string" ? data.name.trim() : "";
        const password = typeof data?.password === "string" ? data.password : "";
        if (!name || !password) return bad();
        const key = `${clientIp(req, server)}|${name.toLowerCase()}`;
        if (app.auth.locked(key)) return json({ error: "too many attempts" }, 429);
        const me = await app.auth.verify(name, password, key);
        return me ? signIn(me) : json({ error: "wrong name or password" }, 401);
      },
    },
    // A forgotten administrator password: a code is written to a file in the data folder (see recovery.ts), only on the local network.
    "/api/recover/start": {
      POST: async (req: Request, server: Server<unknown>) => {
        if (origin !== "lan" || app.auth.userCount() === 0 || !(await body(req))) return forbidden();
        app.recovery.start();
        // the full path only goes to the computer itself; anybody else is told the file's name
        return json({ ok: true, file: RESET_FILE, path: isLoopback(server.requestIP(req)?.address ?? "") ? app.recovery.file : null });
      },
    },
    "/api/recover/finish": {
      POST: async (req: Request, server: Server<unknown>) => {
        const data = await body(req);
        const password = validatePassword(data?.password);
        if (origin !== "lan" || app.auth.userCount() === 0 || !data) return forbidden();
        if (!password) return bad("password too short");
        const result = await app.recovery.finish(str(data.name).trim(), str(data.code), password, clientIp(req, server));
        if (result === "locked") return json({ error: "too many attempts" }, 429);
        return result === "wrong" ? json({ error: "wrong code" }, 401) : signIn(result.user);
      },
    },
    "/api/logout": {
      POST: async (req: Request) => {
        app.auth.endSession(req);
        return json({ ok: true }, 200, { "Set-Cookie": app.auth.clearCookie(secureCookie) });
      },
    },

    // ----- the library -----
    // lets a second start of the program find this one (see instance.ts)
    [PING]: () => json({ app: APP_NAME }),
    // what the "About" window shows; the folder with the program's own files only for the administrator
    "/api/about": browse((req) =>
      json({ name: "Tapalog Reader", version: VERSION, license: "MIT", repo: REPO_URL, site: SITE_URL, components: COMPONENTS, dataFolder: user(req)?.role === "admin" ? app.library.dataFolder : null }),
    ),
    "/api/status": browse(() =>
      json({
        configured: app.library.root !== null,
        books: app.library.count(),
        scanning: app.library.scanning,
        lastScan: app.library.lastScan,
        tunnelUrl: app.tunnel.url,
        lanUrls: app.lanUrls(),
        fullText: app.fullText.enabled,
        writable: app.editor.writable,
      }),
    ),
    "/api/library": browse(() => json({ folders: app.library.folders(), books: shelf(app.library.books()) })),
    // Search by file name, title, author, series or tag. `limit` asks for more than the dropdown's few; format, tag and author narrow it.
    "/api/search": browse((req) => {
      const url = new URL(req.url);
      return json({ books: shelf(app.library.searchNames(url.searchParams.get("q") ?? "", count(url, "limit", 50, 300), filterOf(url))) });
    }),
    // Search inside books (only when the administrator turned the index on). `per` places per book, `limit` books, `book` all places of one book.
    "/api/fulltext": browse((req) => {
      const url = new URL(req.url);
      const accept = filterOf(url);
      const found = app.fullText.search(url.searchParams.get("q") ?? "", {
        perBook: count(url, "per", 3, 100),
        books: count(url, "limit", 40, 100),
        book: url.searchParams.get("book") || undefined,
        accept: accept && ((id) => { const book = app.library.byId(id); return !!book && accept(book); }),
      });
      const books = found.flatMap((f) => {
        const book = app.library.byId(f.id);
        return book ? [{ ...shelf([book])[0]!, hits: f.hits, more: f.more }] : [];
      });
      return json({ enabled: app.fullText.enabled, books, progress: app.fullText.progress() });
    }),
    // How far the index has got: what the page of results tells a reader who may be searching a library that is still being read.
    "/api/fulltext/state": browse(() => json(app.fullText.progress())),
    // The card of a book: title, authors, year, series, description, language and tags. Reading it is browsing; changing it is the administrator's.
    "/api/books/:id/meta": browse((req) => {
      const book = app.library.byId(param(req, "id"));
      return book ? json(cardOf(book)) : notFound();
    }),
    "/api/admin/books/:id/meta": {
      PUT: admin(async (req) => {
        const book = app.library.byId(param(req, "id"));
        const data = await body(req);
        if (!book) return notFound();
        if (!data) return bad();
        try {
          app.library.meta.edit(book.id, data.set, data.reset);
        } catch (err) {
          if (err instanceof MetaError) return bad(err.message);
          throw err;
        }
        return json(cardOf(book));
      }),
    },
    "/api/tags": browse(() => json({ tags: app.library.meta.tags() })),
    // Tags for the whole library at once (administrator): rename (a name already in use merges the two) and take away.
    "/api/admin/tags/rename": {
      POST: admin(async (req) => {
        const data = await body(req);
        if (!data) return bad();
        try {
          return json({ changed: app.library.meta.renameTag(data.from, data.to) });
        } catch (err) {
          if (err instanceof MetaError) return bad(err.message);
          throw err;
        }
      }),
    },
    "/api/admin/tags/remove": {
      POST: admin(async (req) => {
        const data = await body(req);
        if (!data) return bad();
        try {
          return json({ changed: app.library.meta.removeTag(data.tag) });
        } catch (err) {
          if (err instanceof MetaError) return bad(err.message);
          throw err;
        }
      }),
    },
    "/api/cover/:id": browse((req) => {
      const file = app.covers.file(param(req, "id"));
      // A cover never changes for a given id (the id is the book's content), so browsers may keep it.
      return file ? new Response(Bun.file(file), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } }) : notFound();
    }),
    "/api/file/:id": browse((req) => {
      // Only ids from our own index map to a path: there is no way to name an arbitrary file.
      const book = app.library.byId(param(req, "id"));
      return book ? sendBook(book, req) : notFound();
    }),

    // ----- bookmarks: a signed-in reader's own places in books -----
    "/api/bookmarks": {
      GET: (req: Request) => {
        const me = user(req);
        if (!me) return unauthorized();
        const book = new URL(req.url).searchParams.get("book");
        const list = app.bookmarks.list(me.id, book ?? undefined).flatMap((b) => {
          const info = app.library.byId(b.bookId);
          return info ? [{ ...b, book: { name: info.name, title: titleOf(info), ext: info.ext, path: info.path } }] : []; // bookmarks of a book that left the library are kept, just not shown
        });
        return json({ bookmarks: list });
      },
      POST: async (req: Request) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        const book = typeof data?.bookId === "string" ? app.library.byId(data.bookId) : null;
        if (!data || !book || typeof data.label !== "string" || typeof data.view !== "object" || data.view === null || Array.isArray(data.view)) return bad("bad bookmark");
        try {
          return json({ bookmark: app.bookmarks.add(me.id, book.id, data.label, data.view) });
        } catch (err) {
          return bad(err instanceof Error ? err.message : "bad bookmark");
        }
      },
    },
    "/api/bookmarks/:id": {
      DELETE: (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        return app.bookmarks.remove(me.id, Number(param(req, "id"))) ? json({ ok: true }) : notFound();
      },
      POST: async (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const label = (await body(req))?.label;
        return typeof label === "string" && app.bookmarks.rename(me.id, Number(param(req, "id")), label) ? json({ ok: true }) : notFound();
      },
    },

    // ----- projects: a signed-in reader's own collections of places in books and notes -----
    "/api/projects": {
      GET: (req: Request) => {
        const me = user(req);
        return me ? json({ projects: app.projects.list(me.id) }) : unauthorized();
      },
      POST: async (req: Request) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        if (!data) return bad("bad project");
        try {
          return json({ project: app.projects.create(me.id, data.title, data.description) });
        } catch (err) {
          return bad(err instanceof ProjectError ? err.message : "bad project");
        }
      },
    },
    "/api/projects/:id": {
      GET: (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const id = wholeNumber(param(req, "id"));
        const project = app.projects.get(me.id, id);
        const items = project ? app.projects.items(me.id, id) : null;
        return project && items ? json({ project, items: items.map(withBook) }) : notFound();
      },
      POST: async (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        if (!data) return bad("bad project");
        try {
          return app.projects.update(me.id, wholeNumber(param(req, "id")), { title: data.title, description: data.description }) ? json({ ok: true }) : notFound();
        } catch (err) {
          return bad(err instanceof ProjectError ? err.message : "bad project");
        }
      },
      DELETE: (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        return app.projects.remove(me.id, wholeNumber(param(req, "id"))) ? json({ ok: true }) : notFound();
      },
    },
    "/api/projects/:id/items": {
      POST: async (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        if (!data) return bad("bad item");
        const bookId = data.bookId === undefined || data.bookId === null ? null : app.library.byId(str(data.bookId))?.id; // only books of this library
        if (bookId === undefined) return bad("bad item");
        try {
          const item = app.projects.addItem(me.id, wholeNumber(param(req, "id")), { bookId, view: data.view, title: data.title, comment: data.comment, quote: data.quote });
          return item ? json({ item: withBook(item) }) : notFound();
        } catch (err) {
          return bad(err instanceof ProjectError ? err.message : "bad item");
        }
      },
    },
    "/api/projects/:id/items/:item": {
      POST: async (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        if (!data) return bad("bad item");
        try {
          return app.projects.updateItem(me.id, wholeNumber(param(req, "id")), wholeNumber(param(req, "item")), { title: data.title, comment: data.comment, quote: data.quote }) ? json({ ok: true }) : notFound();
        } catch (err) {
          return bad(err instanceof ProjectError ? err.message : "bad item");
        }
      },
      DELETE: (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        return app.projects.removeItem(me.id, wholeNumber(param(req, "id")), wholeNumber(param(req, "item"))) ? json({ ok: true }) : notFound();
      },
    },
    "/api/projects/:id/order": {
      POST: async (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        const order = data?.items;
        if (!Array.isArray(order) || !order.every((n) => Number.isInteger(n))) return bad("bad order");
        if (!app.projects.get(me.id, wholeNumber(param(req, "id")))) return notFound();
        return app.projects.reorder(me.id, wholeNumber(param(req, "id")), order as number[]) ? json({ ok: true }) : bad("bad order");
      },
    },

    // ----- reading progress: where a signed-in reader left each book -----
    "/api/progress": {
      GET: (req: Request) => {
        const me = user(req);
        if (!me) return unauthorized();
        const list = app.progress.recent(me.id).filter((p) => app.library.byId(p.bookId)); // a book that left the library is kept, just not offered
        return json({ progress: list });
      },
    },
    "/api/progress/:id": {
      GET: (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const found = app.progress.get(me.id, param(req, "id"));
        return json({ progress: found });
      },
      PUT: async (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        const book = app.library.byId(param(req, "id"));
        if (!data || !book) return bad("bad progress");
        const view = data.view;
        if (view !== undefined && view !== null && (typeof view !== "object" || Array.isArray(view))) return bad("bad progress");
        try {
          app.progress.save(me.id, book.id, view, typeof data.label === "string" ? data.label : "");
          return json({ ok: true });
        } catch (err) {
          return bad(err instanceof Error ? err.message : "bad progress");
        }
      },
      DELETE: (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        return app.progress.remove(me.id, param(req, "id")) ? json({ ok: true }) : notFound();
      },
    },

    // ----- display settings: how a signed-in reader likes to see each book (turn of the pages, ...) -----
    "/api/display/:id": {
      GET: (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        return json({ display: app.display.get(me.id, param(req, "id")) });
      },
      PUT: async (req: Bun.BunRequest) => {
        const me = user(req);
        if (!me) return unauthorized();
        const data = await body(req);
        const book = app.library.byId(param(req, "id"));
        const display = data ? parseDisplay(data.display) : null;
        if (!book || !display) return bad("bad display");
        app.display.save(me.id, book.id, display);
        return json({ ok: true });
      },
    },

    // ----- share links -----
    "/api/shares": {
      GET: browse((req) => {
        const me = user(req);
        if (!me) return json({ shares: [] });
        return json({ shares: app.shares.list(me.role === "admin" ? "all" : me.id).map((s) => { const info = app.library.byId(s.bookId); return { ...s, title: info ? titleOf(info) : s.name }; }) });
      }),
      POST: browse(async (req) => {
        const data = await body(req);
        const book = typeof data?.bookId === "string" ? app.library.byId(data.bookId) : null;
        if (!data || !book) return bad("unknown book");
        const view = data.view ?? null;
        if (view !== null && (typeof view !== "object" || Array.isArray(view))) return bad("bad view");
        const days = typeof data.expiresInDays === "number" && data.expiresInDays > 0 && data.expiresInDays <= 3650 ? Math.floor(data.expiresInDays) : null;
        try {
          const share = app.shares.create(book.id, view, user(req)?.id ?? null, days);
          return json({ token: share.token, expiresAt: share.expiresAt });
        } catch {
          return bad("view too large");
        }
      }),
    },
    "/api/shares/:token": {
      DELETE: browse((req) => (app.shares.revoke(param(req, "token"), user(req)) ? json({ ok: true }) : forbidden())),
    },
    // What a link's visitor uses: no sign-in, and only the one book the token names.
    "/api/share/:token": (req: Bun.BunRequest) => {
      const share = app.shares.get(param(req, "token"));
      const book = share ? app.library.byId(share.bookId) : null;
      return share && book ? json({ name: book.name, title: titleOf(book), ext: book.ext, view: share.view }) : notFound();
    },
    "/api/share/:token/file": (req: Bun.BunRequest) => {
      const share = app.shares.get(param(req, "token"));
      const book = share ? app.library.byId(share.bookId) : null;
      return book ? sendBook(book, req) : notFound();
    },

    // ----- administration -----
    "/api/admin/settings": {
      GET: admin(() => json(settingsView())),
      POST: admin(async (req) => {
        const data = await body(req);
        if (!data) return bad();
        const patch: Partial<{ lanAccess: "open" | "login"; allowRegistration: boolean }> = {};
        if (data.lanAccess === "open" || data.lanAccess === "login") patch.lanAccess = data.lanAccess;
        if (typeof data.allowRegistration === "boolean") patch.allowRegistration = data.allowRegistration;
        app.config.update(patch);
        if (data.mode === "lan" || data.mode === "internet") app.setMode(data.mode);
        return json(settingsView());
      }),
    },
    // ----- backup of accounts, bookmarks, links and settings -----
    "/api/admin/backup": {
      GET: admin(() => {
        const day = new Date().toISOString().slice(0, 10);
        return new Response(JSON.stringify(app.backup.create(), null, 1), {
          headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="tapalog-reader-backup-${day}.json"`, "Cache-Control": "no-store" },
        });
      }),
    },
    "/api/admin/restore": {
      POST: admin(async (req, _server, me) => {
        const result = await restore(req);
        if (result instanceof Response) return result;
        // the administrator who did this stays signed in if the backup has an account of that name
        const again = app.auth.byName(me.name);
        const session = again?.role === "admin" ? app.auth.startSession(again.id) : null;
        const cookie = session ? app.auth.sessionCookie(session.token, session.maxAgeSeconds, secureCookie) : app.auth.clearCookie(secureCookie);
        return json({ ok: true, signedIn: !!session, ...result.done }, 200, { "Set-Cookie": cookie });
      }),
    },
    "/api/admin/users": {
      POST: admin(async (req) => {
        const data = await body(req);
        const name = validateName(data?.name);
        const password = validatePassword(data?.password);
        if (!name || !password) return bad("name or password too short");
        try {
          await app.auth.createUser(name, password, data?.role === "admin" ? "admin" : "user");
          return json(settingsView());
        } catch {
          return json({ error: "name taken" }, 409);
        }
      }),
    },
    "/api/admin/users/:id": {
      DELETE: admin((req, _server, me) => {
        const id = Number(param(req, "id"));
        if (id === me.id) return json({ error: "cannot delete yourself" }, 400);
        const result = app.auth.deleteUser(id);
        return result === "ok" ? json(settingsView()) : result === "missing" ? notFound() : json({ error: "last admin" }, 400);
      }),
    },
    "/api/admin/users/:id/password": {
      POST: admin(async (req) => {
        const password = validatePassword((await body(req))?.password);
        if (!password) return bad("password too short");
        return (await app.auth.setPassword(Number(param(req, "id")), password)) ? json({ ok: true }) : notFound();
      }),
    },
    // ----- cover thumbnails: drawn by the administrator's browser, stored here -----
    "/api/admin/covers/todo": {
      GET: admin(() => {
        const { todo, remaining } = app.covers.missing(app.library.books(), 100);
        return json({ todo: todo.map(({ id, ext, size }) => ({ id, ext, size })), remaining });
      }),
    },
    "/api/admin/covers/:id": {
      PUT: admin(async (req) => {
        const book = app.library.byId(param(req, "id"));
        if (!book || !COVER_FORMATS.has(book.ext) || !sameOrigin(req) || req.headers.get("content-type") !== "image/jpeg") return bad("not a cover upload");
        const bytes = new Uint8Array(await req.arrayBuffer());
        return bytes.length <= MAX_COVER_BYTES && app.covers.save(book.id, bytes) ? json({ ok: true }) : bad("not a usable JPEG");
      }),
      POST: admin(async (req) => {
        const book = app.library.byId(param(req, "id"));
        if (!book || !(await body(req))) return bad();
        app.covers.markNone(book.id); // "nothing to show": the worker will not ask again
        return json({ ok: true });
      }),
    },
    "/api/admin/covers/:id/source": {
      // Catalogs are read here (the engine's server side); every other format is read in the browser.
      GET: admin(async (req) => {
        const book = app.library.byId(param(req, "id"));
        const root = app.library.root;
        if (!book || book.ext !== "ecatm" || !root) return notFound();
        const cover = await ecatmCover(join(root, ...book.path.split("/"))).catch(() => null);
        return cover ? new Response(cover.bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": cover.mime, "Cache-Control": "no-store" } }) : notFound();
      }),
    },
    "/api/admin/fulltext": {
      GET: admin(() => json(app.fullText.status())),
      POST: admin(async (req) => {
        const data = await body(req);
        if (typeof data?.enabled !== "boolean") return bad();
        app.fullText.setEnabled(data.enabled);
        return json(app.fullText.status());
      }),
    },
    "/api/admin/fulltext/clear": {
      POST: admin(async (req) => {
        if (!(await body(req))) return bad();
        await app.fullText.clear();
        return json(app.fullText.status());
      }),
    },
    // ----- reading the pictures of scanned pages: the administrator's browser does the reading, the server keeps the text -----
    "/api/admin/ocr": {
      GET: admin(() => {
        const books = app.fullText.scans().map(({ book, ocr }) => ({
          id: book.id,
          name: book.name,
          title: titleOf(book),
          path: book.path,
          size: book.size,
          pages: ocr?.pages ?? null,
          done: ocr?.done ?? 0,
          lang: ocr?.lang ?? null,
        }));
        const status = app.fullText.status();
        return json({ enabled: status.enabled, books, recognizedBooks: status.recognizedBooks, recognizedPages: status.recognizedPages });
      }),
    },
    // begins (or goes on with) the reading of a book; answers with the pages already read
    "/api/admin/ocr/:id/start": {
      POST: admin(async (req) => {
        const data = await body(req);
        const book = app.library.byId(param(req, "id"));
        if (!book) return notFound();
        if (book.ext !== "pdf") return bad("only a PDF can be read");
        const pages = data?.pages;
        if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES || !validLang(data?.lang)) return bad();
        return json({ done: app.fullText.ocr.start(book.id, pages, data.lang) });
      }),
    },
    "/api/admin/ocr/:id/pages/:page": {
      PUT: admin(async (req) => {
        const data = await body(req);
        if (typeof data?.text !== "string") return bad();
        const progress = app.fullText.ocr.put(param(req, "id"), Number(param(req, "page")), data.text);
        return progress ? json(progress) : notFound();
      }),
    },
    "/api/admin/ocr/:id": {
      DELETE: admin((req) => (sameOrigin(req) ? json({ removed: app.fullText.ocr.remove(param(req, "id")) }) : forbidden())),
    },
    // ----- editing the library: real changes to the files on disk -----
    // ----- books fetched from a shared Google Drive link -----
    "/api/admin/sources": {
      GET: admin(() => json({ sources: app.sources.list() })),
      POST: admin(async (req) => {
        const data = await body(req);
        if (!data) return bad();
        try {
          return json({ source: app.sources.add(data.name, data.url) });
        } catch (err) {
          if (err instanceof SourceError) return bad(err.code);
          throw err;
        }
      }),
    },
    "/api/admin/sources/:id": {
      DELETE: admin((req) => (app.sources.remove(Number(param(req, "id"))) ? json({ ok: true }) : notFound())),
    },
    "/api/admin/duplicates": {
      POST: admin(async (req) => ((await body(req)) ? json(await findDuplicates(app.library)) : bad())),
    },
    "/api/admin/duplicates/trash": {
      POST: admin(async (req) => {
        const data = await body(req);
        if (!data || !Array.isArray(data.paths) || data.paths.length > 5000 || !data.paths.every((p) => typeof p === "string")) return bad();
        try {
          return json({ trashed: await app.editor.trash(data.paths as string[]) });
        } catch (err) {
          if (err instanceof EditError) return bad(err.code);
          throw err;
        }
      }),
    },
    "/api/admin/import/inspect": {
      POST: admin(async (req) => {
        const data = await body(req);
        if (!data) return bad();
        return importing(async () => json(await app.linkImports.inspect(str(data.link))));
      }),
    },
    "/api/admin/import/thumbnail/:id": {
      GET: admin(async (req) => {
        const id = param(req, "id");
        const picture = isFileId(id) ? await app.linkImports.thumbnail(id) : null;
        return picture ? new Response(picture.bytes, { headers: { "Content-Type": picture.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } }) : notFound();
      }),
    },
    "/api/admin/import": {
      POST: admin(async (req) => {
        const data = await body(req);
        if (!data) return bad();
        return importing(async () => json({ job: await app.linkImports.start(str(data.link), str(data.folder), data.name, data.keep === true) }));
      }),
    },
    "/api/admin/import/:job": {
      GET: admin((req) => {
        const job = app.linkImports.job(param(req, "job"));
        return job ? json({ job }) : notFound();
      }),
      DELETE: admin((req) => (app.linkImports.cancel(param(req, "job")) ? json({ ok: true }) : notFound())),
    },
    "/api/admin/fs/move": {
      POST: admin((req) => edit(req, (d) => app.editor.move(d.kind === "folder" ? "folder" : "book", str(d.path), str(d.to)))),
    },
    "/api/admin/fs/rename": {
      POST: admin((req) => edit(req, (d) => app.editor.rename(d.kind === "folder" ? "folder" : "book", str(d.path), d.name))),
    },
    "/api/admin/fs/mkdir": {
      POST: admin((req) => edit(req, (d) => app.editor.mkdir(str(d.parent), d.name))),
    },
    "/api/rescan": {
      POST: admin(async () => {
        void app.library.rescan();
        return json({ ok: true });
      }),
    },
    "/api/admin/fs/browse": {
      GET: admin(async (req) => {
        const path = new URL(req.url).searchParams.get("path");
        try {
          return json(await listFolders(path));
        } catch (err) {
          if (err instanceof BrowseError) return bad(err.message);
          throw err;
        }
      }),
    },
    "/api/admin/stop": {
      POST: admin(async (req, server) => {
        if (origin !== "lan" || !isLoopback(server.requestIP(req)?.address ?? "") || !(await body(req))) return forbidden();
        setTimeout(() => app.stop(), 200); // after this answer has gone out
        return json({ ok: true });
      }),
    },
    "/api/library/path": {
      POST: admin(async (req) => {
        const path = (await body(req))?.path;
        if (typeof path !== "string" || !path) return bad("path required");
        try {
          await app.library.setRoot(path);
          return json({ ok: true });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }),
    },
  };

  function sendBook(book: { path: string; ext: string }, req: Request): Response {
    const root = app.library.root;
    if (!root) return notFound();
    const fileName = book.path.slice(book.path.lastIndexOf("/") + 1);
    return serveFile(join(root, ...book.path.split("/")), mimeOf(book.ext), req.headers.get("range"), fileName);
  }

  return routes;
}

export function startServers(app: App, opts: { hostname: string; port: number }): Servers {
  const internal = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: buildRoutes(app, "tunnel") as never,
    fetch: notFound,
  });
  try {
    const lan = Bun.serve({ hostname: opts.hostname, port: opts.port, routes: buildRoutes(app, "lan") as never, fetch: notFound });
    return {
      lan,
      internal,
      stop() {
        lan.stop(true);
        internal.stop(true);
      },
    };
  } catch (err) {
    internal.stop(true);
    throw err;
  }
}
