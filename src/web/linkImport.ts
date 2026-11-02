import { t, type Key } from "./i18n";
import { api, ApiError, badge, el, formatBytes, openModal } from "./ui";

interface Inspected {
  /** The Drive file id when the link was a Drive one (its picture can be shown). */
  id: string | null;
  name: string;
  ext: string;
  size: number;
  /** A zip: the book is taken out of it after the download (`ext` is then a guess, "zip" when there is none). */
  archive: boolean;
}

interface Job {
  id: string;
  state: "running" | "done" | "failed";
  received: number;
  total: number;
  path: string | null;
  bookId: string | null;
  error: string | null;
  duplicateOf: string | null;
  unpacking: boolean;
}

const EDIT_ERRORS: Record<string, Key> = {
  "invalid-name": "edit.err.invalidName",
  exists: "edit.err.exists",
  missing: "edit.err.missing",
  "read-only": "edit.err.readOnly",
  "no-library": "edit.err.missing",
};

const IMPORT_CODES = new Set(["bad-link", "folder", "not-a-file", "web-page", "not-found", "closed", "local-address", "unsupported", "wrong-content", "archive-empty", "archive-many", "archive-encrypted", "archive-broken", "too-big", "unreachable", "busy", "cancelled"]);

function failure(code: string): string {
  return t(EDIT_ERRORS[code] ?? (IMPORT_CODES.has(code) ? (`link.err.${code}` as Key) : "link.err.failed"));
}
interface Source {
  id: number;
  name: string;
  url: string;
}

const SOURCE_ERRORS: Record<string, Key> = { "bad-link": "link.err.bad-link", "invalid-name": "link.err.sourceName", exists: "link.err.sourceExists", "too-many": "link.err.sourceMany" };

const codeOf = (err: unknown) => (err instanceof ApiError ? err.message : "failed");

/**
 * "Download a book by link": paste a link (a Google Drive share link or the address of a file on any
 * site), see what it is (name, size, a picture when Drive has one), choose the name and the folder,
 * then watch it come in. The server does the fetching; the page only ever talks to this app.
 */
export function openLinkImport(opts: { folders: readonly string[]; saved: () => Promise<void>; open: (bookId: string) => void }): void {
  let running: string | null = null;
  const modal = openModal(t("link.title"), () => {
    if (running) void api(`/api/admin/import/${running}`, undefined, "DELETE").catch(() => {}); // closing the dialog stops a download in progress
  });
  const show = (...nodes: Node[]) => modal.body.replaceChildren(...nodes);

  function askLink(link = "", problem = ""): void {
    const input = el("input", { type: "text", autocomplete: "off", required: true, value: link, placeholder: "https://…" });
    const error = el("div", { class: "error", textContent: problem });
    const go = el("button", { type: "submit", class: "btn primary", textContent: t("link.check") });
    const form = el("form", { class: "stack" }, el("label", {}, el("span", { textContent: t("link.linkLabel") }), input), el("p", { class: "muted small", textContent: t("link.linkHint") }), go, error);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      go.disabled = true;
      go.textContent = t("link.checking");
      try {
        review(input.value, await api<Inspected>("/api/admin/import/inspect", { link: input.value }));
      } catch (err) {
        error.textContent = failure(codeOf(err));
        go.disabled = false;
        go.textContent = t("link.check");
      }
    });
    show(form, sourcesBlock());
    input.focus();
  }

  /** The sites books are taken from, kept for next time: a click opens one in a new tab, where a link to a file can be copied. */
  function sourcesBlock(): HTMLElement {
    const list = el("ul", { class: "source-list" });
    const note = el("p", { class: "muted small" });
    const name = el("input", { type: "text", autocomplete: "off", placeholder: t("link.sourceName"), maxLength: 100 });
    const url = el("input", { type: "text", autocomplete: "off", placeholder: "https://…" });
    const add = el("button", { type: "submit", class: "btn", textContent: t("link.sourceAdd") });
    const error = el("div", { class: "error" });
    const form = el("form", { class: "source-add" }, name, url, add);

    const draw = (sources: Source[]) => {
      note.textContent = t(sources.length ? "link.sourcesNote" : "link.sourcesEmpty");
      list.replaceChildren(
        ...sources.map((source) => {
          const remove = el("button", { type: "button", class: "icon-btn small", textContent: "×", title: t("link.sourceRemove") });
          remove.setAttribute("aria-label", `${t("link.sourceRemove")}: ${source.name}`);
          remove.addEventListener("click", async () => {
            await api(`/api/admin/sources/${source.id}`, undefined, "DELETE").catch(() => {});
            await load();
          });
          const link = el("a", { href: source.url, target: "_blank", rel: "noopener noreferrer", textContent: source.name, title: source.url });
          return el("li", {}, link, remove);
        }),
      );
    };
    const load = async () => draw((await api<{ sources: Source[] }>("/api/admin/sources").catch(() => ({ sources: [] }))).sources);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      try {
        await api("/api/admin/sources", { name: name.value, url: url.value });
        name.value = url.value = "";
        await load();
      } catch (err) {
        error.textContent = t(SOURCE_ERRORS[codeOf(err)] ?? "link.err.failed");
      }
    });
    void load();
    return el("section", { class: "sources" }, el("h3", { textContent: t("link.sources") }), note, list, form, error);
  }

  function review(link: string, info: Inspected, problem = "", name = info.name, folder = ""): void {
    // a picture exists only for Drive links; for any other address the cover appears once the book is in the library
    let frame: HTMLElement | null = null;
    if (info.id) {
      const picture = el("img", { class: "import-cover", alt: "", src: `/api/admin/import/thumbnail/${encodeURIComponent(info.id)}` });
      const shown = el("div", { class: "import-cover-frame" }, picture);
      picture.addEventListener("error", () => shown.replaceChildren(el("span", { class: "muted small", textContent: t("link.noPreview") })));
      frame = shown;
    }
    const nameInput = el("input", { type: "text", value: name, required: true, autocomplete: "off" });
    const select = el("select", {});
    for (const path of ["", ...opts.folders.filter((f) => f !== "")]) {
      const depth = path ? path.split("/").length : 0;
      const label = path ? path.slice(path.lastIndexOf("/") + 1) : t("shelf.root");
      select.append(el("option", { value: path, selected: path === folder, textContent: `${"  ".repeat(depth)}${path ? "📁" : "⌂"} ${label}` }));
    }
    const error = el("div", { class: "error", textContent: problem });
    const go = el("button", { type: "submit", class: "btn primary", textContent: t("link.download") });
    const back = el("button", { type: "button", class: "btn", textContent: t("link.back") });
    back.addEventListener("click", () => askLink(link));
    const form = el(
      "form",
      { class: "stack" },
      el("div", { class: "import-info" }, badge(info.archive && info.ext === "zip" ? "zip" : info.ext), el("span", { class: "muted", textContent: info.size ? formatBytes(info.size) : "" })),
      ...(info.archive ? [el("p", { class: "muted small", textContent: t("link.archiveNote") })] : []),
      el("label", {}, el("span", { textContent: t("link.name") }), el("div", { class: "import-name" }, nameInput, el("span", { class: "muted", textContent: info.archive && info.ext === "zip" ? "" : `.${info.ext}` }))),
      el("label", {}, el("span", { textContent: t("link.folder") }), select),
      el("div", { class: "import-actions" }, go, back),
      error,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      go.disabled = true;
      const request = { link, folder: select.value, name: nameInput.value };
      const retry = () => review(link, info, "", request.name, request.folder);
      const begin = async (keep: boolean): Promise<void> => progress((await api<{ job: Job }>("/api/admin/import", { ...request, keep })).job, retry, () => void begin(true).catch((err) => showFailed(codeOf(err), retry)));
      try {
        await begin(false);
      } catch (err) {
        error.textContent = failure(codeOf(err));
        go.disabled = false;
      }
    });
    show(el("div", { class: "import-review" }, ...(frame ? [frame] : []), form));
  }

  function progress(first: Job, retry: () => void, saveAnyway: () => void): void {
    running = first.id;
    const bar = el("progress", {});
    if (first.total) bar.max = first.total; // a server that does not tell the size gets a bar that only shows activity
    const text = el("span", { class: "muted small" });
    const cancel = el("button", { type: "button", class: "btn", textContent: t("link.cancel") });
    cancel.addEventListener("click", () => void api(`/api/admin/import/${first.id}`, undefined, "DELETE").catch(() => {}));
    show(el("div", { class: "stack" }, bar, text, cancel));
    const draw = (job: Job) => {
      if (job.total) bar.value = job.received;
      if (job.unpacking) return void (text.textContent = t("link.unpacking"));
      text.textContent = job.total ? t("link.progress", { done: formatBytes(job.received), total: formatBytes(job.total) }) : formatBytes(job.received);
    };
    draw(first);
    const poll = async (): Promise<void> => {
      let job: Job;
      try {
        job = (await api<{ job: Job }>(`/api/admin/import/${first.id}`)).job;
      } catch {
        return void setTimeout(poll, 1000); // a hiccup in the connection: keep asking
      }
      draw(job);
      if (job.state === "running") return void setTimeout(poll, 400);
      running = null;
      if (job.state === "failed") return showFailed(job.error ?? "failed", retry, job.duplicateOf, saveAnyway);
      await opts.saved();
      show(
        el(
          "div",
          { class: "stack" },
          el("p", { textContent: t("link.saved", { path: job.path ?? "" }) }),
          (() => {
            const open = el("button", { type: "button", class: "btn primary", textContent: t("link.open") });
            open.addEventListener("click", () => {
              modal.close();
              if (job.bookId) opts.open(job.bookId);
            });
            return open;
          })(),
        ),
      );
    };
    void poll();
  }

  function showFailed(code: string, retry: () => void, duplicateOf: string | null = null, saveAnyway?: () => void): void {
    const again = el("button", { type: "button", class: "btn", textContent: t("link.back") });
    again.addEventListener("click", retry);
    if (code === "duplicate" && saveAnyway) {
      // the same book is already in the library: say where, and let the administrator keep it anyway
      const keep = el("button", { type: "button", class: "btn primary", textContent: t("link.keepAnyway") });
      keep.addEventListener("click", saveAnyway);
      return show(el("div", { class: "stack" }, el("p", { textContent: t("link.err.duplicate", { path: duplicateOf ?? "" }) }), el("div", { class: "import-actions" }, again, keep)));
    }
    show(el("div", { class: "stack" }, el("div", { class: "error", textContent: failure(code) }), again));
  }

  askLink();
}
