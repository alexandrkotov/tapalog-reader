import { authPanel, type Me } from "./account";
import { bookHash } from "./bookmarks";
import { lang, t } from "./i18n";
import { createPictures, type Pictures } from "./projectPictures";
import { api, ApiError, badge, el, openModal, store, type Modal } from "./ui";

interface ProjectSummary {
  id: number;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  items: number;
}

interface Item {
  id: number;
  bookId: string | null;
  view: unknown;
  title: string;
  comment: string;
  quote: string;
  createdAt: number;
  /** What the library knows about the book now; null for a note and for a book that left the library. */
  book: { name: string; ext: string; path: string } | null;
  missing: boolean;
}

export interface ProjectsContext {
  me: Me;
  /** Called after the reader signed in or created an account. */
  onSignedIn(): void;
}

const date = (ms: number) => new Date(ms).toLocaleDateString(lang());

/**
 * A reader's projects: collections of places from different books and own notes. Like bookmarks they live
 * on the server under the reader's name, so anonymous visitors are offered an account first.
 */
export function openProjects(ctx: ProjectsContext): void {
  const pictures = createPictures();
  const modal = openModal(t("projects.title"), () => pictures.destroy());
  if (!ctx.me.user) {
    modal.body.append(
      el("p", { class: "muted", textContent: t("projects.signIn") }),
      authPanel(ctx.me, () => {
        modal.close();
        ctx.onSignedIn();
      }),
    );
    return;
  }
  void showList(modal, pictures);
}

export interface AddToProjectContext {
  me: Me;
  /** The book being read. */
  book: { id: string; name: string };
  /** The reader showing it: where it is, a suggested name, and the passage selected or marked in it (text formats). */
  reader: () => { getView?(): unknown; getLabel?(): string; getPassage?(): { view: unknown; quote: string } | null } | null;
  /** Called after the reader signed in or created an account. */
  onSignedIn(): void;
}

const LAST_PROJECT = "tapalog.project"; // a convenience of this browser: the project the last place went to
const NEW = "new";
const MAX_QUOTE = 2000;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Adds the place on screen (or the passage selected in a text book) to a project, choosing one or making a new
 * one. The reading place is untouched: the dialog is over the book, and the place is taken when it opens.
 */
export function openAddToProject(ctx: AddToProjectContext): void {
  const pictures = createPictures();
  const modal = openModal(t("projects.addTitle"), () => pictures.destroy());
  if (!ctx.me.user) {
    modal.body.append(
      el("p", { class: "muted", textContent: t("projects.signIn") }),
      authPanel(ctx.me, () => {
        modal.close();
        ctx.onSignedIn();
      }),
    );
    return;
  }
  const reader = ctx.reader();
  const passage = reader?.getPassage?.() ?? null;
  const view = passage?.view ?? reader?.getView?.() ?? null;
  const unknownPlace = !!reader?.getView && !view; // the book is still opening: nothing to come back to yet
  const error = el("div", { class: "error" });

  const projectSelect = el("select", { ariaLabel: t("projects.project") });
  const newName = field({ max: 200, placeholder: t("projects.new") });
  const title = field({ value: reader?.getLabel?.() || ctx.book.name, max: 200, placeholder: t("projects.itemTitle") });
  const comment = area({ max: 5000, placeholder: t("projects.comment") });
  const quoteText = passage ? oneLine(passage.quote).slice(0, MAX_QUOTE) : "";
  const quote = quoteText ? area({ value: quoteText, max: MAX_QUOTE, placeholder: t("projects.quote") }) : null;
  const submit = el("button", { type: "submit", class: "btn primary", textContent: t("projects.addTitle") });
  const form = el("form", { class: "project-edit" }, el("label", { class: "project-label", textContent: t("projects.project") }, projectSelect), newName, title, ...(quote ? [quote] : []), comment, el("div", { class: "row project-buttons" }, submit), error);
  modal.body.append(form);

  let projects: ProjectSummary[] = [];
  const showNew = () => (newName.hidden = projectSelect.value !== NEW);
  projectSelect.addEventListener("change", showNew);
  void api<{ projects: ProjectSummary[] }>("/api/projects")
    .then((data) => {
      projects = data.projects;
      const last = Number(store.get(LAST_PROJECT));
      projectSelect.replaceChildren(...projects.map((p) => el("option", { value: String(p.id), textContent: p.title })), el("option", { value: NEW, textContent: t("projects.newOption") }));
      projectSelect.value = projects.some((p) => p.id === last) ? String(last) : projects.length ? String(projects[0]!.id) : NEW;
      showNew();
      queueMicrotask(() => (projectSelect.value === NEW ? newName : comment).focus());
    })
    .catch(() => (error.textContent = t("projects.failed")));

  let created: ProjectSummary | null = null; // made by an attempt that then failed: a retry must not make a second one
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    if (!projects.length && !created && !projectSelect.value) return; // the list has not arrived
    if (unknownPlace) {
      error.textContent = t("bookmark.noView");
      return;
    }
    submit.disabled = true;
    try {
      let target = created ?? projects.find((p) => String(p.id) === projectSelect.value) ?? null;
      if (!target) {
        if (!newName.value.trim()) {
          newName.focus();
          return;
        }
        created = target = (await api<{ project: ProjectSummary }>("/api/projects", { title: newName.value })).project;
      }
      await api(`/api/projects/${target.id}/items`, { bookId: ctx.book.id, ...(view ? { view } : {}), title: title.value.trim() || ctx.book.name, comment: comment.value, ...(quote ? { quote: quote.value } : {}) });
      store.set(LAST_PROJECT, String(target.id));
      const chosen = target;
      const open = el("button", { type: "button", class: "btn primary", textContent: t("projects.open") });
      open.addEventListener("click", () => void showProject(modal, chosen.id, pictures));
      const close = el("button", { type: "button", class: "btn", textContent: t("common.close") });
      close.addEventListener("click", () => modal.close());
      modal.body.replaceChildren(el("p", { class: "project-added", textContent: t("projects.added", { title: chosen.title }) }), el("div", { class: "row project-buttons" }, open, close));
      close.focus();
    } catch {
      error.textContent = t("projects.failed");
    } finally {
      submit.disabled = false;
    }
  });
}

/** Runs a change and says so when the server refused it. */
async function attempt(error: HTMLElement, run: () => Promise<unknown>): Promise<boolean> {
  error.textContent = "";
  try {
    await run();
    return true;
  } catch {
    error.textContent = t("projects.failed");
    return false;
  }
}

const field = (props: { value?: string; placeholder?: string; max: number; label?: string }) => el("input", { type: "text", maxLength: props.max, value: props.value ?? "", placeholder: props.placeholder ?? "", autocomplete: "off", ariaLabel: props.label ?? props.placeholder ?? "" });
const area = (props: { value?: string; placeholder?: string; max: number }) => el("textarea", { rows: 3, maxLength: props.max, value: props.value ?? "", placeholder: props.placeholder ?? "", ariaLabel: props.placeholder ?? "" });

async function showList(modal: Modal, pictures: Pictures): Promise<void> {
  const error = el("div", { class: "error" });
  const list = el("div", { class: "project-list" });
  const name = field({ max: 200, placeholder: t("projects.new") });
  const create = el("button", { type: "submit", class: "btn primary", textContent: t("projects.create") });
  const form = el("form", { class: "row" }, name, create);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = name.value.trim();
    if (!title) return;
    let made: { project: ProjectSummary } | null = null;
    if (await attempt(error, async () => (made = await api<{ project: ProjectSummary }>("/api/projects", { title })))) void showProject(modal, made!.project.id, pictures);
  });
  modal.body.replaceChildren(form, error, list);

  const { projects } = await api<{ projects: ProjectSummary[] }>("/api/projects").catch(() => ({ projects: null }));
  if (!projects) {
    error.textContent = t("projects.failed");
    return;
  }
  list.replaceChildren(
    ...(projects.length
      ? projects.map((p) => {
          const go = el("button", { type: "button", class: "link project-go", textContent: p.title });
          go.addEventListener("click", () => void showProject(modal, p.id, pictures));
          const del = el("button", { type: "button", class: "icon-btn small", title: t("common.delete"), textContent: "×" });
          del.addEventListener("click", async () => {
            if (!confirm(t("projects.deleteConfirm", { title: p.title }))) return;
            if (await attempt(error, () => api(`/api/projects/${p.id}`, undefined, "DELETE"))) void showList(modal, pictures);
          });
          const meta = `${t("projects.items", { n: p.items })} · ${date(p.updatedAt)}`;
          return el("div", { class: "project-row" }, el("div", { class: "grow" }, go, ...(p.description ? [el("div", { class: "muted small project-about", textContent: p.description })] : []), el("div", { class: "muted small", textContent: meta })), del);
        })
      : [el("p", { class: "muted", textContent: t("projects.none") })]),
  );
}

async function showProject(modal: Modal, id: number, pictures: Pictures): Promise<void> {
  let project: ProjectSummary | null = null;
  let items: Item[] = [];
  let editingHead = false;
  let editingItem: number | null = null;
  const error = el("div", { class: "error" });

  async function load(): Promise<void> {
    try {
      const data = await api<{ project: ProjectSummary; items: Item[] }>(`/api/projects/${id}`);
      project = data.project;
      items = data.items;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return void showList(modal, pictures); // it is gone (deleted elsewhere): back to the list
      error.textContent = t("projects.failed");
    }
    draw();
  }
  const change = async (run: () => Promise<unknown>) => {
    if (await attempt(error, run)) {
      editingHead = false;
      editingItem = null;
    }
    await load();
  };

  const buttons = (...children: HTMLElement[]) => el("div", { class: "row project-buttons" }, ...children);
  const cancel = (onClick: () => void) => {
    const b = el("button", { type: "button", class: "btn", textContent: t("common.cancel") });
    b.addEventListener("click", onClick);
    return b;
  };

  function header(p: ProjectSummary): HTMLElement {
    if (editingHead) {
      const title = field({ value: p.title, max: 200, placeholder: t("projects.name") });
      const about = area({ value: p.description, max: 2000, placeholder: t("projects.description") });
      const form = el("form", { class: "project-edit" }, title, about, buttons(el("button", { type: "submit", class: "btn primary", textContent: t("common.save") }), cancel(() => ((editingHead = false), draw()))));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void change(() => api(`/api/projects/${id}`, { title: title.value, description: about.value }));
      });
      queueMicrotask(() => title.select());
      return form;
    }
    const edit = el("button", { type: "button", class: "icon-btn small", title: t("projects.edit"), textContent: "✎" });
    edit.addEventListener("click", () => ((editingHead = true), (editingItem = null), draw()));
    return el("div", { class: "project-head" }, el("div", { class: "grow" }, el("h3", { class: "project-title", textContent: p.title }), ...(p.description ? [el("div", { class: "muted project-about", textContent: p.description })] : [])), edit);
  }

  function row(item: Item, index: number): HTMLElement {
    if (editingItem === item.id) {
      const title = field({ value: item.title, max: 200, placeholder: t("projects.itemTitle") });
      const comment = area({ value: item.comment, max: 5000, placeholder: t("projects.comment") });
      const quote = item.quote ? area({ value: item.quote, max: 2000, placeholder: t("projects.quote") }) : null;
      const form = el("form", { class: "project-item project-edit" }, title, comment, ...(quote ? [quote] : []), buttons(el("button", { type: "submit", class: "btn primary", textContent: t("common.save") }), cancel(() => ((editingItem = null), draw()))));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void change(() => api(`/api/projects/${id}/items/${item.id}`, { title: title.value, comment: comment.value, ...(quote ? { quote: quote.value } : {}) }));
      });
      queueMicrotask(() => title.select());
      return form;
    }

    let name: HTMLElement;
    const picture = el("div", { class: "project-slot" }); // a picture of the area appears here when it scrolls into view, for the formats that can be pictured
    if (item.bookId && !item.missing) {
      const go = () => {
        modal.close();
        location.hash = bookHash(item.bookId!, item.view);
      };
      name = el("button", { type: "button", class: "link project-go", textContent: item.title });
      name.addEventListener("click", go);
      pictures.show(picture, item, go);
    } else name = el("span", { class: "project-go", textContent: item.title });

    const source = item.missing ? el("div", { class: "project-missing", textContent: t("projects.missing") }) : item.book ? el("div", { class: "muted small project-source" }, `${item.book.name} `, badge(item.book.ext)) : el("div", { class: "muted small project-source", textContent: t("projects.note") });
    const small = (label: string, text: string, onClick: () => void, disabled = false) => {
      const b = el("button", { type: "button", class: "icon-btn small", title: label, ariaLabel: label, textContent: text, disabled });
      b.addEventListener("click", onClick);
      return b;
    };
    const move = (by: number) => {
      const order = items.map((i) => i.id);
      [order[index], order[index + by]] = [order[index + by]!, order[index]!];
      void change(() => api(`/api/projects/${id}/order`, { items: order }));
    };
    return el(
      "div",
      { class: "project-item" },
      el(
        "div",
        { class: "grow" },
        name,
        source,
        picture,
        ...(item.quote ? [el("blockquote", { class: "project-quote", textContent: item.quote })] : []),
        ...(item.comment ? [el("p", { class: "project-comment", textContent: item.comment })] : []),
      ),
      small(t("projects.up"), "↑", () => move(-1), index === 0),
      small(t("projects.down"), "↓", () => move(1), index === items.length - 1),
      small(t("projects.edit"), "✎", () => ((editingItem = item.id), (editingHead = false), draw())),
      small(t("common.delete"), "×", () => {
        if (confirm(t("projects.itemDeleteConfirm", { title: item.title }))) void change(() => api(`/api/projects/${id}/items/${item.id}`, undefined, "DELETE"));
      }),
    );
  }

  function draw(): void {
    if (!project) return;
    const back = el("button", { type: "button", class: "btn project-back", textContent: t("projects.back") });
    back.addEventListener("click", () => void showList(modal, pictures));

    const title = field({ max: 200, placeholder: t("projects.itemTitle") });
    const comment = area({ max: 5000, placeholder: t("projects.comment") });
    const add = el("form", { class: "project-add" }, el("h3", { textContent: t("projects.addNote") }), title, comment, buttons(el("button", { type: "submit", class: "btn", textContent: t("projects.addNote") })));
    add.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!title.value.trim()) return;
      void change(() => api(`/api/projects/${id}/items`, { title: title.value, comment: comment.value }));
    });

    modal.body.replaceChildren(back, header(project), el("div", { class: "project-items" }, ...(items.length ? items.map(row) : [el("p", { class: "muted", textContent: t("projects.empty") })])), add, error);
  }

  await load();
}
