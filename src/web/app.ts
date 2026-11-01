import { authScreen, openAuthDialog, setupScreen, signOut, type Me } from "./account";
import { openAdmin } from "./admin";
import { makeCovers, stopCovers } from "./covers";
import { LANGS, lang, setLang, t, type Lang } from "./i18n";
import { mountReader, VIEW_FORMATS, type Reader } from "./readers/mount";
import { openMyLinks, openShareDialog } from "./share";
import { api, ApiError, badge, el, store } from "./ui";

interface Book {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  cover?: boolean;
}
interface Status {
  configured: boolean;
  books: number;
  scanning: boolean;
  lastScan: { books: number; added: number; removed: number; ms: number } | null;
  fullText?: boolean;
}
interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  books: Book[];
  total: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const treeEl = $("tree");
const mainEl = $("main");
const panelEl = $("panel");
const searchEl = $<HTMLInputElement>("search");
const resultsEl = $("search-results");
const scanEl = $("scan-state");
const coverEl = $("cover-state");
const accountEl = $("account");
const langEl = $<HTMLSelectElement>("lang");
const toggleEl = $("panel-toggle");

// ---------- library state and tree ----------

let me: Me | null = null;
let books: Book[] = [];
let booksById = new Map<string, Book>();
let root: FolderNode = { path: "", name: "", folders: [], books: [], total: 0 };
let folderNodes = new Map<string, FolderNode>();
/** Ids whose cover was made after the library list was loaded. */
const newCovers = new Set<string>();
const expanded = new Set<string>(JSON.parse(store.get("expanded") ?? "[]") as string[]);
let currentId: string | null = null;

function buildTree(folders: string[], list: Book[]): FolderNode {
  const nodes = new Map<string, FolderNode>([["", { path: "", name: "", folders: [], books: [], total: 0 }]]);
  const ensure = (path: string): FolderNode => {
    let node = nodes.get(path);
    if (node) return node;
    const slash = path.lastIndexOf("/");
    node = { path, name: path.slice(slash + 1), folders: [], books: [], total: 0 };
    nodes.set(path, node);
    ensure(slash < 0 ? "" : path.slice(0, slash)).folders.push(node);
    return node;
  };
  for (const f of folders) ensure(f);
  for (const b of list) {
    const slash = b.path.lastIndexOf("/");
    ensure(slash < 0 ? "" : b.path.slice(0, slash)).books.push(b);
  }
  const count = (n: FolderNode): number => (n.total = n.books.length + n.folders.reduce((s, f) => s + count(f), 0));
  count(nodes.get("")!);
  folderNodes = nodes;
  return nodes.get("")!;
}

function renderTree(): void {
  const keepScroll = panelEl.scrollTop;
  const rows = (node: FolderNode): HTMLUListElement => {
    const ul = el("ul");
    for (const folder of [...node.folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const open = expanded.has(folder.path);
      const row = el("div", { class: "node", title: folder.path }, el("span", { class: "twisty", textContent: open ? "▼" : "▶" }), el("span", { class: "label", textContent: folder.name }), el("span", { class: "count", textContent: String(folder.total) }));
      row.dataset.folder = folder.path;
      const li = el("li", {}, row);
      if (open) li.append(rows(folder)); // children of a closed folder are never built: ten thousand books stay cheap
      ul.append(li);
    }
    for (const book of [...node.books].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const row = el("div", { class: `node${book.id === currentId ? " selected" : ""}`, title: book.path }, el("span", { class: "twisty" }), badge(book.ext), el("span", { class: "label", textContent: book.name }));
      row.dataset.book = book.id;
      ul.append(el("li", {}, row));
    }
    return ul;
  };
  treeEl.replaceChildren(rows(root));
  panelEl.scrollTop = keepScroll;
}

treeEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>(".node");
  if (!row) return;
  if (row.dataset.folder !== undefined) {
    const path = row.dataset.folder;
    if (target.classList.contains("twisty")) {
      // the arrow only opens or closes the folder...
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      store.set("expanded", JSON.stringify([...expanded]));
      renderTree();
    } else {
      // ...its name also shows what is inside, as a shelf of covers
      location.hash = `#folder=${encodeURIComponent(path)}`;
      if (matchMedia("(max-width: 720px)").matches) panelEl.hidden = true;
    }
  } else if (row.dataset.book) {
    location.hash = `#book=${row.dataset.book}`;
    if (matchMedia("(max-width: 720px)").matches) panelEl.hidden = true; // phone: the panel covers the reader
  }
});

/** Opens every folder above a book so it is visible in the tree. */
function reveal(book: Book): void {
  const parts = book.path.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
  renderTree();
  treeEl.querySelector(`[data-book="${book.id}"]`)?.scrollIntoView({ block: "nearest" });
}

async function loadLibrary(): Promise<void> {
  const data = await api<{ folders: string[]; books: Book[] }>("/api/library");
  books = data.books;
  booksById = new Map(books.map((b) => [b.id, b]));
  root = buildTree(data.folders, books);
  renderTree();
  // Covers are drawn by the administrator's browser: while one has the page open, missing ones get made.
  if (me?.user?.role === "admin") void makeCovers({ onSaved: coverSaved, onState: coverState });
}

function coverSaved(id: string): void {
  newCovers.add(id);
  for (const box of document.querySelectorAll<HTMLElement>(`.thumb[data-cover-id="${id}"]`)) fillThumb(box, id, true);
}

function coverState(left: number): void {
  coverEl.hidden = left === 0;
  coverEl.textContent = t("cover.left", { n: left });
}

// ---------- covers and shelves ----------

const hasCover = (book: Book) => book.cover === true || newCovers.has(book.id);

function fillThumb(box: HTMLElement, id: string, covered: boolean, ext = ""): void {
  box.replaceChildren(covered ? el("img", { src: `/api/cover/${id}`, alt: "", loading: "lazy", decoding: "async" }) : el("span", { class: `ph badge-${ext}`, textContent: ext }));
}

/** A book's cover, or a coloured tile with its format until a cover exists. */
function thumb(book: Book, extra = ""): HTMLElement {
  const box = el("div", { class: `thumb ${extra}`.trim() });
  box.dataset.coverId = book.id;
  fillThumb(box, book.id, hasCover(book), book.ext);
  return box;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
const SHELF_PAGE = 240;

/** What is inside one folder, as cards: sub-folders first, then books with their covers. */
function showShelf(path: string): void {
  stopReader();
  const node = folderNodes.get(path) ?? root;
  const parts = node.path ? node.path.split("/") : [];
  for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
  currentId = null;
  renderTree();
  document.title = `${node.name || t("shelf.root")} — ${t("app.title")}`;

  const crumbs: Node[] = [el("a", { href: "#", textContent: t("shelf.root") })];
  parts.forEach((part, i) => crumbs.push(el("span", { class: "sep", textContent: "/" }), el("a", { href: `#folder=${encodeURIComponent(parts.slice(0, i + 1).join("/"))}`, textContent: part })));
  const cards: HTMLElement[] = [
    ...[...node.folders].sort(byName).map((f) =>
      el("a", { class: "card folder", href: `#folder=${encodeURIComponent(f.path)}`, title: f.path }, el("div", { class: "thumb folder-tile", textContent: "📁" }), el("div", { class: "cap" }, el("span", { class: "name", textContent: f.name }), el("span", { class: "count", textContent: String(f.total) }))),
    ),
    ...[...node.books].sort(byName).map((b) => el("a", { class: "card", href: `#book=${b.id}`, title: b.path }, el("div", { class: "thumbwrap" }, thumb(b), badge(b.ext)), el("div", { class: "cap" }, el("span", { class: "name", textContent: b.name })))),
  ];
  const grid = el("div", { class: "shelf" });
  const more = el("button", { type: "button", class: "btn shelf-more" });
  let shown = 0;
  const renderMore = () => {
    grid.append(...cards.slice(shown, shown + SHELF_PAGE));
    shown = Math.min(cards.length, shown + SHELF_PAGE);
    more.hidden = shown >= cards.length;
    more.textContent = t("shelf.more", { n: cards.length - shown });
  };
  more.addEventListener("click", renderMore);
  renderMore();
  mainEl.replaceChildren(
    el("div", { class: "shelf-head" }, ...crumbs),
    el("div", { class: "shelf-body" }, cards.length ? grid : el("p", { class: "shelf-empty", textContent: t("shelf.empty") }), more),
  );
}


// ---------- panel toggle ----------

function setPanel(visible: boolean): void {
  panelEl.hidden = !visible;
  toggleEl.setAttribute("aria-expanded", String(visible));
  store.set("panel", visible ? "1" : "0");
}
setPanel(store.get("panel") !== "0" && !matchMedia("(max-width: 720px)").matches);
toggleEl.addEventListener("click", () => setPanel(Boolean(panelEl.hidden)));

// ---------- search ----------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchAbort: AbortController | undefined;
/** What Enter and the arrow keys walk through: file-name hits, then places inside books. */
let entries: { book: Book; view?: unknown }[] = [];
let activeHit = -1;
let fullTextOn = false;
interface ContentBook extends Book {
  hits: { snippet: string; view: unknown }[];
}

/** A snippet from the index marks the found words with control characters; turn those into <mark>s without ever touching HTML. */
function snippetNode(snippet: string): HTMLElement {
  const out = el("span", { class: "snip" });
  snippet.split("\u0001").forEach((part, i) => {
    const [marked, rest] = i === 0 ? [null, part] : part.split("\u0002");
    if (marked !== null && marked !== undefined) out.append(el("mark", { textContent: marked }));
    out.append(rest ?? "");
  });
  return out;
}

function showHits(names: Book[], content: ContentBook[] | null, query: string): void {
  entries = [];
  resultsEl.replaceChildren();
  const row = (book: Book, view: unknown, ...extra: (Node | string)[]) => {
    const li = el("li", { class: entries.length === 0 ? "active" : "", role: "option" }, thumb(book, "sm"), badge(book.ext), el("span", { class: "name", textContent: book.name }), ...extra);
    li.dataset.index = String(entries.length);
    entries.push({ book, view });
    return li;
  };
  for (const book of names) resultsEl.append(row(book, undefined, el("span", { class: "path", textContent: book.path })));
  if (content?.length) {
    resultsEl.append(el("li", { class: "group", textContent: t("search.inContents") }));
    for (const book of content) for (const hit of book.hits) resultsEl.append(row(book, hit.view, snippetNode(hit.snippet)));
  }
  activeHit = entries.length ? 0 : -1;
  if (!entries.length && content !== null) resultsEl.append(el("li", { class: "empty", textContent: t("search.none", { q: query }) }));
  resultsEl.hidden = false;
}

function pickHit(entry: { book: Book; view?: unknown }): void {
  resultsEl.hidden = true;
  searchEl.blur();
  location.hash = `#book=${entry.book.id}${entry.view ? `&view=${encodeURIComponent(JSON.stringify(entry.view))}` : ""}`;
  setPanel(true);
  reveal(entry.book);
}

searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchEl.value.trim();
  if (!q) {
    resultsEl.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    searchAbort?.abort();
    searchAbort = new AbortController();
    const { signal } = searchAbort;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
      if (!res.ok) return;
      const names = ((await res.json()) as { books: Book[] }).books;
      showHits(names, fullTextOn ? null : [], q); // names appear at once; the slower content search joins them below
      if (!fullTextOn) return;
      const found = await fetch(`/api/fulltext?q=${encodeURIComponent(q)}`, { signal });
      if (found.ok) showHits(names, ((await found.json()) as { books: ContentBook[] }).books, q);
    } catch {
      /* superseded by a newer query */
    }
  }, 150);
});
searchEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    resultsEl.hidden = true;
    return;
  }
  if (resultsEl.hidden || !entries.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    activeHit = (activeHit + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
    const rows = resultsEl.querySelectorAll("li[data-index]");
    rows.forEach((row, i) => row.classList.toggle("active", i === activeHit));
    rows[activeHit]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && entries[activeHit]) {
    pickHit(entries[activeHit]!);
  }
});
resultsEl.addEventListener("mousedown", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("li[data-index]");
  if (row) pickHit(entries[Number(row.dataset.index)]!);
});
searchEl.addEventListener("blur", () => setTimeout(() => (resultsEl.hidden = true), 120));
searchEl.addEventListener("focus", () => {
  if (entries.length && searchEl.value.trim()) resultsEl.hidden = false;
});

// ---------- reader ----------

let reader: Reader | null = null;
let openToken = 0; // readers load lazily: a stale load must not replace the book opened after it

function stopReader(): void {
  openToken++;
  reader?.destroy();
  reader = null;
}

function message(title: string, text: string, ...extra: Node[]): void {
  stopReader();
  mainEl.replaceChildren(el("div", { class: "message" }, el("h2", { textContent: title }), el("p", { textContent: text }), ...extra));
}

/** The shape of a view depends on the book's format: EcatmView for catalogs, PageView for paged documents. */
function parseHash(): { book: string | null; folder: string | null; view: unknown } {
  const params = new URLSearchParams(location.hash.slice(1));
  let view: unknown = null;
  try {
    const raw = params.get("view");
    if (raw) view = JSON.parse(raw);
  } catch {
    /* a broken link opens the book at its start */
  }
  return { book: params.get("book"), folder: params.get("folder"), view };
}

const writeView = (book: Book, view: unknown) => history.replaceState(null, "", `#book=${book.id}&view=${encodeURIComponent(JSON.stringify(view))}`);

/** Shows a reader in the main area under a title bar. `bar` adds buttons at its right end. */
function showReader(spec: { name: string; ext: string; path?: string; fileUrl: string; view: unknown; onView?: (view: unknown) => void; bar?: (current: () => Reader | null) => HTMLElement[] }): void {
  const token = ++openToken;
  reader?.destroy();
  reader = null;
  const host = el("div", { class: "reader-host" });
  mainEl.replaceChildren(
    el("div", { class: "reader-bar" }, badge(spec.ext), el("span", { class: "title", textContent: spec.name }), el("span", { class: "path grow", textContent: spec.path ?? "" }), ...(spec.bar?.(() => reader) ?? [])),
    host,
  );
  document.title = `${spec.name} — ${t("app.title")}`;
  mountReader(host, { ...spec, onError: (title, text) => token === openToken && message(title, text) })
    .then((r) => {
      if (token === openToken) reader = r;
      else r.destroy();
    })
    .catch((err: unknown) => {
      if (token === openToken) message(t("pdf.error"), err instanceof Error ? err.message : String(err));
    });
}

function openBook(book: Book, view: unknown): void {
  currentId = book.id;
  renderTree();
  const share = el("button", { type: "button", class: "btn", textContent: t("share.button") });
  showReader({
    name: book.name,
    ext: book.ext,
    path: book.path,
    fileUrl: `/api/file/${book.id}`,
    view,
    onView: (v) => writeView(book, v),
    bar: (current) => {
      share.addEventListener("click", () => void openShareDialog({ id: book.id, name: book.name, ext: book.ext, view: VIEW_FORMATS.has(book.ext) ? (current()?.getView?.() ?? null) : null }));
      return [share];
    },
  });
}

function route(): void {
  const { book, folder, view } = parseHash();
  if (!book) {
    if (!books.length) {
      currentId = null;
      document.title = t("app.title");
      renderTree();
      return message(t("pick.title"), t("pick.empty"));
    }
    return showShelf(folder ?? "");
  }
  const found = booksById.get(book);
  if (!found) return message(t("book.missing.title"), t("book.missing.text"));
  openBook(found, view);
  reveal(found);
}
addEventListener("hashchange", () => {
  if (!sharePage) route();
});

// ---------- top bar: language and account ----------

function applyStaticText(): void {
  document.title = t("app.title");
  $("brand").textContent = t("app.title");
  toggleEl.title = t("panel.toggle");
  toggleEl.setAttribute("aria-label", t("panel.toggle"));
  searchEl.placeholder = t("search.placeholder");
  scanEl.textContent = t("scan.running");
  langEl.replaceChildren(...(Object.entries(LANGS) as [Lang, string][]).map(([code, name]) => el("option", { value: code, textContent: name, selected: code === lang() })));
}
$("brand").addEventListener("click", (event) => {
  event.preventDefault();
  if (sharePage || !books.length) return;
  history.pushState(null, "", location.pathname);
  route();
});
langEl.addEventListener("change", () => {
  setLang(langEl.value as Lang);
  void (sharePage ? bootShare(sharePage) : boot());
});

function renderAccount(): void {
  const buttons: HTMLElement[] = [];
  const button = (label: string, onClick: () => void) => {
    const b = el("button", { type: "button", class: "btn", textContent: label });
    b.addEventListener("click", onClick);
    return b;
  };
  if (me?.user) {
    buttons.push(el("span", { class: "who", textContent: me.user.name }));
    buttons.push(button(t("account.links"), () => void openMyLinks()));
    if (me.user.role === "admin") buttons.push(button(t("account.settings"), () => void openAdmin(me!.user!, () => void refreshLibrary())));
    buttons.push(button(t("account.signOut"), async () => (await signOut(), void boot())));
  } else if (me && !me.setupNeeded) {
    buttons.push(button(t("account.signIn"), () => openAuthDialog(me!, () => void boot())));
  }
  accountEl.replaceChildren(...buttons);
}

// ---------- first run, sign-in and background refresh ----------

function folderScreen(): HTMLElement {
  const input = el("input", { type: "text", placeholder: "/path/to/your/books", autocomplete: "off" });
  const error = el("div", { class: "error" });
  const form = el("form", {}, input, el("button", { type: "submit", class: "btn primary", textContent: t("library.button") }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      await api("/api/library/path", { path: input.value.trim() });
      void boot();
    } catch (err) {
      error.textContent = err instanceof ApiError && err.status === 400 ? t("library.error") : String(err);
    }
  });
  queueMicrotask(() => input.focus());
  return el("div", { class: "message" }, el("h2", { textContent: t("library.title") }), el("p", { textContent: t("library.text") }), form, error);
}

let lastScanKey: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function pollStatus(): Promise<Status> {
  const status = await api<Status>("/api/status");
  fullTextOn = status.fullText === true;
  scanEl.hidden = !status.scanning;
  const key = JSON.stringify(status.lastScan);
  if (lastScanKey !== null && key !== lastScanKey) await loadLibrary();
  lastScanKey = key;
  return status;
}

/** After the admin changes the library folder or rescans: wait for the scan, then redraw the tree. */
async function refreshLibrary(): Promise<void> {
  lastScanKey = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const status = await pollStatus().catch(() => null);
    if (status && !status.scanning) break;
  }
  await loadLibrary();
  if (!parseHash().book) route();
}

async function boot(): Promise<void> {
  clearInterval(pollTimer);
  stopCovers();
  coverState(0);
  stopReader();
  applyStaticText();
  me = await api<Me>("/api/me");
  renderAccount();
  books = [];
  root = buildTree([], []);
  renderTree();

  if (me.setupNeeded && me.setupPossible) return void mainEl.replaceChildren(setupScreen(me, () => void boot()));
  if (!me.canBrowse) {
    stopReader();
    return void mainEl.replaceChildren(authScreen(me, () => void boot()));
  }
  let status: Status;
  try {
    status = await pollStatus();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return void boot();
    throw err;
  }
  if (!status.configured) {
    if (me.user?.role === "admin") return void mainEl.replaceChildren(folderScreen());
    return message(t("library.title"), t("library.wait"));
  }
  while (status.scanning) {
    await new Promise((r) => setTimeout(r, 400)); // let the first scan finish so the tree isn't drawn empty
    status = await pollStatus();
  }
  await loadLibrary();
  route();
  pollTimer = setInterval(() => void pollStatus().catch((err: unknown) => err instanceof ApiError && err.status === 401 && void boot()), 4000);
}

// ---------- a shared link: one book, nothing else ----------

const sharePage = location.pathname.startsWith("/s/") ? decodeURIComponent(location.pathname.slice(3).replace(/\/$/, "")) : null;

async function bootShare(token: string): Promise<void> {
  document.body.classList.add("share-mode");
  applyStaticText();
  try {
    const info = await api<{ name: string; ext: string; view: unknown }>(`/api/share/${encodeURIComponent(token)}`);
    showReader({ name: info.name, ext: info.ext, fileUrl: `/api/share/${encodeURIComponent(token)}/file`, view: info.view });
  } catch {
    message(t("shared.gone.title"), t("shared.gone.text"));
  }
}

if (sharePage) void bootShare(sharePage);
else void boot();
