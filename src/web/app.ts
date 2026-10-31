import { authScreen, openAuthDialog, setupScreen, signOut, type Me } from "./account";
import { openAdmin } from "./admin";
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
}
interface Status {
  configured: boolean;
  books: number;
  scanning: boolean;
  lastScan: { books: number; added: number; removed: number; ms: number } | null;
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
const accountEl = $("account");
const langEl = $<HTMLSelectElement>("lang");
const toggleEl = $("panel-toggle");

// ---------- library state and tree ----------

let me: Me | null = null;
let books: Book[] = [];
let booksById = new Map<string, Book>();
let root: FolderNode = { path: "", name: "", folders: [], books: [], total: 0 };
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
  const row = (event.target as HTMLElement).closest<HTMLElement>(".node");
  if (!row) return;
  if (row.dataset.folder !== undefined) {
    const path = row.dataset.folder;
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    store.set("expanded", JSON.stringify([...expanded]));
    renderTree();
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
let hits: Book[] = [];
let activeHit = -1;

function showHits(list: Book[], query: string): void {
  hits = list;
  activeHit = list.length ? 0 : -1;
  resultsEl.replaceChildren();
  if (!list.length) resultsEl.append(el("li", { class: "empty", textContent: t("search.none", { q: query }) }));
  list.forEach((book, i) => {
    const li = el("li", { class: i === 0 ? "active" : "", role: "option" }, badge(book.ext), el("span", { textContent: book.name }), el("span", { class: "path", textContent: book.path }));
    li.dataset.index = String(i);
    resultsEl.append(li);
  });
  resultsEl.hidden = false;
}

function pickHit(book: Book): void {
  resultsEl.hidden = true;
  searchEl.blur();
  location.hash = `#book=${book.id}`;
  setPanel(true);
  reveal(book);
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
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: searchAbort.signal });
      if (res.ok) showHits(((await res.json()) as { books: Book[] }).books, q);
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
  if (resultsEl.hidden || !hits.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    activeHit = (activeHit + (event.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
    resultsEl.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === activeHit));
    resultsEl.querySelectorAll("li")[activeHit]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && hits[activeHit]) {
    pickHit(hits[activeHit]!);
  }
});
resultsEl.addEventListener("mousedown", (event) => {
  const li = (event.target as HTMLElement).closest<HTMLElement>("li[data-index]");
  if (li) pickHit(hits[Number(li.dataset.index)]!);
});
searchEl.addEventListener("blur", () => setTimeout(() => (resultsEl.hidden = true), 120));
searchEl.addEventListener("focus", () => {
  if (hits.length && searchEl.value.trim()) resultsEl.hidden = false;
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
function parseHash(): { book: string | null; view: unknown } {
  const params = new URLSearchParams(location.hash.slice(1));
  let view: unknown = null;
  try {
    const raw = params.get("view");
    if (raw) view = JSON.parse(raw);
  } catch {
    /* a broken link opens the book at its start */
  }
  return { book: params.get("book"), view };
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
  const { book, view } = parseHash();
  if (!book) {
    currentId = null;
    document.title = t("app.title");
    renderTree();
    message(t("pick.title"), books.length ? t("pick.some") : t("pick.empty"));
    return;
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
