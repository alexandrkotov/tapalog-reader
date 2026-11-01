import { t, type Key } from "./i18n";
import { api, ApiError, badge, el, formatBytes, openModal } from "./ui";

interface Inspected {
  id: string;
  name: string;
  ext: string;
  size: number;
}

interface Job {
  id: string;
  state: "running" | "done" | "failed";
  received: number;
  total: number;
  path: string | null;
  bookId: string | null;
  error: string | null;
}

/** The profile of the person whose daily sharing of rare Soviet-era technical books inspired this feature. */
const THANKS_URL = "https://www.facebook.com/1shirshov/";

const EDIT_ERRORS: Record<string, Key> = {
  "invalid-name": "edit.err.invalidName",
  exists: "edit.err.exists",
  missing: "edit.err.missing",
  "read-only": "edit.err.readOnly",
  "no-library": "edit.err.missing",
};

const DRIVE_CODES = new Set(["bad-link", "folder", "not-a-file", "not-found", "closed", "unsupported", "wrong-content", "too-big", "unreachable", "busy", "cancelled"]);

function failure(code: string): string {
  return t(EDIT_ERRORS[code] ?? (DRIVE_CODES.has(code) ? (`drive.err.${code}` as Key) : "drive.err.failed"));
}
const codeOf = (err: unknown) => (err instanceof ApiError ? err.message : "failed");

function thanks(): HTMLElement {
  const [before = "", after = ""] = t("drive.thanks", { name: "\u0001" }).split("\u0001");
  const link = el("a", { href: THANKS_URL, target: "_blank", rel: "noopener noreferrer", textContent: t("drive.thanksName") });
  const note = el("p", { class: "muted small drive-thanks" });
  note.append(before, link, after);
  return note;
}

/**
 * "Download a book from Google Drive": paste a link, see what it is (picture, name, size), choose
 * the name and the folder, then watch it come in. The server does the fetching; the page only
 * ever talks to this app.
 */
export function openDriveImport(opts: { folders: readonly string[]; saved: () => Promise<void>; open: (bookId: string) => void }): void {
  let running: string | null = null;
  const modal = openModal(t("drive.title"), () => {
    if (running) void api(`/api/admin/import/${running}`, undefined, "DELETE").catch(() => {}); // closing the dialog stops a download in progress
  });
  const foot = thanks();
  const show = (...nodes: Node[]) => modal.body.replaceChildren(...nodes, foot);

  function askLink(link = "", problem = ""): void {
    const input = el("input", { type: "text", autocomplete: "off", required: true, value: link, placeholder: "https://drive.google.com/…" });
    const error = el("div", { class: "error", textContent: problem });
    const go = el("button", { type: "submit", class: "btn primary", textContent: t("drive.check") });
    const form = el("form", { class: "stack" }, el("label", {}, el("span", { textContent: t("drive.linkLabel") }), input), el("p", { class: "muted small", textContent: t("drive.linkHint") }), go, error);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      go.disabled = true;
      go.textContent = t("drive.checking");
      try {
        review(input.value, await api<Inspected>("/api/admin/import/inspect", { link: input.value }));
      } catch (err) {
        error.textContent = failure(codeOf(err));
        go.disabled = false;
        go.textContent = t("drive.check");
      }
    });
    show(form);
    input.focus();
  }

  function review(link: string, info: Inspected, problem = "", name = info.name, folder = ""): void {
    const picture = el("img", { class: "drive-cover", alt: "", src: `/api/admin/import/thumbnail/${encodeURIComponent(info.id)}` });
    const frame = el("div", { class: "drive-cover-frame" }, picture);
    picture.addEventListener("error", () => frame.replaceChildren(el("span", { class: "muted small", textContent: t("drive.noPreview") })));
    const nameInput = el("input", { type: "text", value: name, required: true, autocomplete: "off" });
    const select = el("select", {});
    for (const path of ["", ...opts.folders.filter((f) => f !== "")]) {
      const depth = path ? path.split("/").length : 0;
      const label = path ? path.slice(path.lastIndexOf("/") + 1) : t("shelf.root");
      select.append(el("option", { value: path, selected: path === folder, textContent: `${"  ".repeat(depth)}${path ? "📁" : "⌂"} ${label}` }));
    }
    const error = el("div", { class: "error", textContent: problem });
    const go = el("button", { type: "submit", class: "btn primary", textContent: t("drive.download") });
    const back = el("button", { type: "button", class: "btn", textContent: t("drive.back") });
    back.addEventListener("click", () => askLink(link));
    const form = el(
      "form",
      { class: "stack" },
      el("div", { class: "drive-info" }, badge(info.ext), el("span", { class: "muted", textContent: formatBytes(info.size) })),
      el("label", {}, el("span", { textContent: t("drive.name") }), el("div", { class: "drive-name" }, nameInput, el("span", { class: "muted", textContent: `.${info.ext}` }))),
      el("label", {}, el("span", { textContent: t("drive.folder") }), select),
      el("div", { class: "drive-actions" }, go, back),
      error,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      go.disabled = true;
      try {
        const { job } = await api<{ job: Job }>("/api/admin/import", { link, folder: select.value, name: nameInput.value });
        progress(job, () => review(link, info, "", nameInput.value, select.value));
      } catch (err) {
        error.textContent = failure(codeOf(err));
        go.disabled = false;
      }
    });
    show(el("div", { class: "drive-review" }, frame, form));
  }

  function progress(first: Job, retry: () => void): void {
    running = first.id;
    const bar = el("progress", { max: first.total, value: first.received });
    const text = el("span", { class: "muted small" });
    const cancel = el("button", { type: "button", class: "btn", textContent: t("drive.cancel") });
    cancel.addEventListener("click", () => void api(`/api/admin/import/${first.id}`, undefined, "DELETE").catch(() => {}));
    show(el("div", { class: "stack" }, bar, text, cancel));
    const draw = (job: Job) => {
      bar.value = job.received;
      text.textContent = t("drive.progress", { done: formatBytes(job.received), total: formatBytes(job.total) });
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
      if (job.state === "failed") return showFailed(job.error ?? "failed", retry);
      await opts.saved();
      show(
        el(
          "div",
          { class: "stack" },
          el("p", { textContent: t("drive.saved", { path: job.path ?? "" }) }),
          (() => {
            const open = el("button", { type: "button", class: "btn primary", textContent: t("drive.open") });
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

  function showFailed(code: string, retry: () => void): void {
    const again = el("button", { type: "button", class: "btn", textContent: t("drive.back") });
    again.addEventListener("click", retry);
    show(el("div", { class: "stack" }, el("div", { class: "error", textContent: failure(code) }), again));
  }

  askLink();
}
