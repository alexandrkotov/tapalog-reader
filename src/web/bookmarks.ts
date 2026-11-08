import { authPanel, type Me } from "./account";
import { lang, t } from "./i18n";
import { api, badge, el, openModal } from "./ui";

interface Bookmark {
  id: number;
  bookId: string;
  label: string;
  view: unknown;
  createdAt: number;
  book: { name: string; title: string; ext: string; path: string };
}

export interface BookmarkContext {
  me: Me;
  /** The book being read, when there is one: its place can be added and its bookmarks come first. */
  book: { id: string; title: string } | null;
  /** The reader showing it, for the current view and a suggested name. */
  reader: () => { getView?(): unknown; getLabel?(): string } | null;
  /** Called after the reader signed in or created an account. */
  onSignedIn(): void;
}

/** The address that opens a book at a saved place (without a view, just the book). */
export const bookHash = (bookId: string, view: unknown): string => (view === null || view === undefined ? `#book=${bookId}` : `#book=${bookId}&view=${encodeURIComponent(JSON.stringify(view))}`);
const hashFor = (b: Bookmark) => bookHash(b.bookId, b.view);

/**
 * A reader's bookmarks. Anonymous visitors are offered an account first: bookmarks live on the
 * server under a name, so they follow the reader to any device.
 */
export function openBookmarks(ctx: BookmarkContext): void {
  if (!ctx.me.user) {
    const modal = openModal(t("bookmark.title"));
    modal.body.append(
      el("p", { class: "muted", textContent: t("bookmark.signIn") }),
      authPanel(ctx.me, () => {
        modal.close();
        ctx.onSignedIn();
      }),
    );
    return;
  }

  const modal = openModal(t("bookmark.title"));
  const list = el("div", { class: "bookmark-list" });
  const error = el("div", { class: "error" });

  const row = (b: Bookmark, here: boolean) => {
    const go = el("button", { type: "button", class: "link bookmark-go", textContent: b.label });
    go.addEventListener("click", () => {
      modal.close();
      location.hash = hashFor(b);
    });
    const rename = el("button", { type: "button", class: "icon-btn small", title: t("bookmark.rename"), textContent: "✎" });
    rename.addEventListener("click", async () => {
      const next = prompt(t("bookmark.rename"), b.label)?.trim();
      if (next && next !== b.label) {
        await api(`/api/bookmarks/${b.id}`, { label: next }).catch(() => undefined);
        void load();
      }
    });
    const del = el("button", { type: "button", class: "icon-btn small", title: t("common.delete"), textContent: "×" });
    del.addEventListener("click", async () => {
      await api(`/api/bookmarks/${b.id}`, undefined, "DELETE").catch(() => undefined);
      void load();
    });
    return el(
      "div",
      { class: "bookmark-row" },
      el("div", { class: "grow" }, go, el("div", { class: "muted small", textContent: (here ? "" : `${b.book.title} · `) + new Date(b.createdAt).toLocaleDateString(lang()) })),
      here ? el("span") : badge(b.book.ext),
      rename,
      del,
    );
  };

  async function load(): Promise<void> {
    const { bookmarks } = await api<{ bookmarks: Bookmark[] }>("/api/bookmarks");
    const mine = bookmarks.filter((b) => b.bookId === ctx.book?.id);
    const others = bookmarks.filter((b) => b.bookId !== ctx.book?.id);
    list.replaceChildren(
      ...(ctx.book ? [el("h3", { textContent: ctx.book.title }), ...(mine.length ? mine.map((b) => row(b, true)) : [el("p", { class: "muted", textContent: t("bookmark.none") })])] : []),
      ...(others.length ? [...(ctx.book ? [el("h3", { textContent: t("bookmark.others") })] : []), ...others.map((b) => row(b, false))] : ctx.book ? [] : [el("p", { class: "muted", textContent: t("bookmark.none") })]),
    );
  }

  if (ctx.book) {
    const book = ctx.book;
    const reader = ctx.reader();
    const label = el("input", { type: "text", maxLength: 200, placeholder: t("bookmark.placeholder"), value: reader?.getLabel?.() ?? "", autocomplete: "off" });
    const add = el("button", { type: "submit", class: "btn primary", textContent: t("bookmark.add") });
    const form = el("form", { class: "row" }, label, add);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      const view = reader?.getView?.();
      if (!view) {
        error.textContent = t("bookmark.noView");
        return;
      }
      try {
        await api("/api/bookmarks", { bookId: book.id, label: label.value.trim() || book.title, view });
        label.value = "";
        void load();
      } catch {
        error.textContent = t("bookmark.failed");
      }
    });
    modal.body.append(form, error);
    queueMicrotask(() => label.select());
  }
  modal.body.append(list);
  void load();
}
