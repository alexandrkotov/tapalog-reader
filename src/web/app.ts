import { createPdfExporter, mountViewerInShadow, type EcatmView } from "@ecm/viewer-engine";
import wasmUrl from "@ecm/viewer-engine/sql-wasm.wasm";
import pdfFontUrl from "@ecm/viewer-engine/fonts/DejaVuSans.ttf";

interface Book {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
}
interface Status {
  libraryPath: string | null;
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

/** localStorage may throw (private windows, blocked storage); the UI must work without it. */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not persisted */
    }
  },
};

const badge = (ext: string) => el("span", { class: `badge badge-${ext}`, textContent: ext });

// ---------- library state and tree ----------

let books: Book[] = [];
let booksById = new Map<string, Book>();
let root: FolderNode = { path: "", name: "", folders: [], books: [], total: 0 };
let expanded = new Set<string>(JSON.parse(store.get("expanded") ?? "[]") as string[]);
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
    const node = ensure(slash < 0 ? "" : b.path.slice(0, slash));
    node.books.push(b);
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
  const data = (await (await fetch("/api/library")).json()) as { folders: string[]; books: Book[] };
  books = data.books;
  booksById = new Map(books.map((b) => [b.id, b]));
  root = buildTree(data.folders, books);
  renderTree();
}

// ---------- panel toggle ----------

const toggleEl = $("panel-toggle");
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
  if (!list.length) {
    resultsEl.append(el("li", { class: "empty", textContent: `Nothing found for “${query}”` }));
  }
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
      showHits(((await res.json()) as { books: Book[] }).books, q);
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

type Viewer = ReturnType<typeof mountViewerInShadow>;
let viewer: Viewer | null = null;

function message(title: string, text: string, ...extra: Node[]): void {
  viewer?.destroy();
  viewer = null;
  mainEl.replaceChildren(el("div", { class: "message" }, el("h2", { textContent: title }), el("p", { textContent: text }), ...extra));
}

function parseHash(): { book: string | null; view: EcatmView | null } {
  const params = new URLSearchParams(location.hash.slice(1));
  let view: EcatmView | null = null;
  try {
    const raw = params.get("view");
    if (raw) view = JSON.parse(raw) as EcatmView;
  } catch {
    /* a broken link opens the book at its start */
  }
  return { book: params.get("book"), view };
}

function openBook(book: Book, view: EcatmView | null): void {
  currentId = book.id;
  renderTree();
  viewer?.destroy();
  viewer = null;
  const host = el("div", { class: "reader-host" });
  mainEl.replaceChildren(
    el("div", { class: "reader-bar" }, badge(book.ext), el("span", { class: "title", textContent: book.name }), el("span", { class: "path", textContent: book.path })),
    host,
  );
  document.title = `${book.name} — Tapalog Reader`;

  if (book.ext === "ecatm") {
    const v = mountViewerInShadow(host, {
      mode: "reader",
      wasmUrl,
      exportPdf: createPdfExporter(pdfFontUrl),
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      persist: false,
      analytics: false,
      regionSelect: true,
      onEvent: (type, detail) => {
        if (type !== "view") return;
        // Keep the address bar a deep link to exactly what is on screen.
        history.replaceState(null, "", `#book=${book.id}&view=${encodeURIComponent(JSON.stringify(detail))}`);
      },
    });
    viewer = v;
    void v.openUrl(`/api/file/${book.id}`, { fetchInit: { credentials: "include" }, view: view ?? undefined }).catch((err: unknown) => {
      message("Could not open this catalog", err instanceof Error ? err.message : String(err));
    });
    return;
  }

  host.replaceChildren(
    el("div", { class: "message" }, el("h2", { textContent: book.name }), el("p", { textContent: `A built-in reader for ${book.ext.toUpperCase()} is coming soon.` }), el("a", { class: "button", href: `/api/file/${book.id}`, textContent: "Download the file" })),
  );
}

function route(): void {
  const { book, view } = parseHash();
  if (!book) {
    currentId = null;
    document.title = "Tapalog Reader";
    renderTree();
    message("Pick a book", books.length ? "Choose one in the panel on the left, or use the search box." : "The library is empty.");
    return;
  }
  const found = booksById.get(book);
  if (!found) {
    message("Book not found", "It may have been moved or deleted from the library folder.");
    return;
  }
  openBook(found, view);
  reveal(found);
}
addEventListener("hashchange", route);

// ---------- first run and background refresh ----------

function setupScreen(): void {
  const input = el("input", { type: "text", placeholder: "/path/to/your/books", autocomplete: "off" });
  const error = el("div", { class: "error" });
  const form = el("form", {}, input, el("button", { type: "submit", textContent: "Use this folder" }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const res = await fetch("/api/library/path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: input.value.trim() }) });
    if (res.ok) {
      await boot();
    } else {
      error.textContent = ((await res.json().catch(() => ({}))) as { error?: string }).error === "admin only" ? "The folder can only be chosen on the computer that runs the server." : "That is not a folder this computer can read.";
    }
  });
  message("Choose the library folder", "Type the full path of the folder with your books. Subfolders are included.", form, error);
  input.focus();
}

let lastScanKey: string | null = null;
/** Polls the server; a finished rescan refreshes the tree but never touches the book being read. */
async function pollStatus(): Promise<Status> {
  const status = (await (await fetch("/api/status")).json()) as Status;
  scanEl.hidden = !status.scanning;
  const key = JSON.stringify(status.lastScan);
  if (lastScanKey !== null && key !== lastScanKey) await loadLibrary();
  lastScanKey = key;
  return status;
}

async function boot(): Promise<void> {
  let status = await pollStatus();
  if (status.libraryPath && status.scanning) {
    // First scan still running: wait for it so the tree isn't drawn empty.
    while (status.scanning) {
      await new Promise((r) => setTimeout(r, 400));
      status = await pollStatus();
    }
  }
  if (!status.libraryPath) return setupScreen();
  await loadLibrary();
  route();
}

void boot();
setInterval(() => void pollStatus().catch(() => {}), 4000);
