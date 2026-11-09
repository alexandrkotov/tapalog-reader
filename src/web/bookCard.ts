import { t, type Key } from "./i18n";
import { tagsHash } from "./tags";
import { openOcr } from "./ocrWindow";
import { openProof } from "./proofWindow";
import { api, ApiError, badge, el, formatBytes, openModal } from "./ui";

interface Fields {
  title: string;
  authors: string[];
  year: number | null;
  series: string;
  description: string;
  language: string;
  tags: string[];
}
type FieldName = keyof Fields;

/** What the server says about a book: what the library shows, what the file says, which fields were typed by hand, where the file is. */
export interface Card {
  id: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  copies: string[];
  fields: Fields;
  auto: Partial<Omit<Fields, "tags">>;
  edited: string[];
}

const text = (value: unknown): string => (Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value));

/** One field as a form row: a label, a control, and (when it was typed here) what the file says with a way back to it. */
interface Row {
  name: FieldName;
  node: HTMLElement;
  read(): unknown;
  show(card: Card): void;
}

function row(name: FieldName, label: Key, hint: Key | null, control: HTMLInputElement | HTMLTextAreaElement, toValue: () => unknown, toText: (value: unknown) => string, undo: (name: FieldName) => void): Row {
  const note = el("div", { class: "muted small card-note" });
  const reset = el("button", { type: "button", class: "btn card-reset" });
  reset.addEventListener("click", () => undo(name));
  const node = el("div", { class: "card-field" }, el("label", { class: "card-label" }, el("span", { textContent: t(label) }), control), ...(hint ? [el("div", { class: "muted small", textContent: t(hint) })] : []), note);
  return {
    name,
    node,
    read: toValue,
    show(card) {
      control.value = toText(card.fields[name]);
      const inFile = card.auto[name as keyof Card["auto"]];
      const edited = card.edited.includes(name);
      note.replaceChildren();
      if (inFile !== undefined && text(inFile) !== text(card.fields[name])) note.append(`${t("card.inFile", { value: text(inFile) })} `);
      if (edited) {
        // what the button does depends on whether the file says anything here: take its words, or just throw away what was typed
        const fileSays = inFile !== undefined && text(inFile) !== "";
        reset.textContent = `↺ ${t(fileSays ? "card.reset" : "card.clear")}`;
        reset.title = t(fileSays ? "card.resetHint" : name === "title" ? "card.clearTitleHint" : "card.clearHint");
        note.append(reset);
      }
    },
  };
}

/** The window "About the book": everyone can read it, the administrator can change it. Calls `changed` with the card after every change that was saved. */
export async function openBookCard(id: string, canEdit: boolean, changed: (card: Card) => void = () => {}): Promise<void> {
  const modal = openModal(t("card.title"));
  modal.body.append(el("p", { class: "muted", textContent: t("card.loading") }));
  let card: Card;
  try {
    card = await api<Card>(`/api/books/${encodeURIComponent(id)}/meta`);
  } catch {
    modal.body.replaceChildren(el("p", { class: "muted", textContent: t("card.failed") }));
    return;
  }
  const file = () =>
    el(
      "dl",
      { class: "card-file" },
      el("dt", { textContent: t("card.file") }),
      el("dd", { textContent: `${card.name}.${card.ext}` }),
      el("dt", { textContent: t("card.path") }),
      el("dd", { class: "card-path", textContent: card.path }),
      el("dt", { textContent: t("card.size") }),
      el("dd", { textContent: formatBytes(card.size) }),
      ...(card.copies.length > 1 ? [el("dt", { textContent: t("card.copies") }), ...card.copies.filter((p) => p !== card.path).map((p) => el("dd", { class: "card-path", textContent: p }))] : []),
    );
  const head = () => el("div", { class: "reader-title" }, badge(card.ext), el("span", { class: "card-heading", textContent: card.fields.title || card.name }));
  const note = el("p", { class: "muted small", textContent: t("card.keeps") });

  if (!canEdit) {
    const f = card.fields;
    const line = (label: Key, value: string) => (value ? [el("dt", { textContent: t(label) }), el("dd", { textContent: value })] : []);
    modal.body.replaceChildren(
      head(),
      el(
        "dl",
        { class: "card-file card-read" },
        ...line("card.authors", f.authors.join(", ")),
        ...line("card.year", f.year === null ? "" : String(f.year)),
        ...line("card.series", f.series),
        ...line("card.language", f.language),
        ...(f.tags.length ? [el("dt", { textContent: t("card.tags") }), el("dd", {}, ...f.tags.flatMap((tag, i) => [...(i ? [" "] : []), el("a", { class: "card-tag", href: tagsHash([tag.toLowerCase()]), textContent: tag, onclick: () => modal.close() })]))] : []),
      ),
      ...(f.description ? [el("p", { class: "card-description", textContent: f.description })] : []),
      file(),
      el("p", { class: "muted small", textContent: t("card.readOnly") }),
      note,
    );
    return;
  }

  const known = await api<{ tags: { tag: string; books: number }[] }>("/api/tags").then((r) => r.tags, () => []);
  const error = el("p", { class: "project-missing", hidden: true });
  const saved = el("span", { class: "muted small card-saved", hidden: true, textContent: t("card.saved") });
  const put = async (body: { set?: Record<string, unknown>; reset?: string[] }): Promise<Card | null> => {
    error.hidden = true;
    try {
      const next = await api<Card>(`/api/admin/books/${encodeURIComponent(id)}/meta`, body, "PUT");
      card = next;
      changed(next);
      return next;
    } catch (err) {
      error.textContent = err instanceof ApiError && /^(title|authors|year|series|description|language|tags)$/.test(err.message) ? t(`card.bad.${err.message}` as Key) : t("card.bad.other");
      error.hidden = false;
      return null;
    }
  };

  const undo = async (name: FieldName) => {
    const next = await put({ reset: [name] });
    if (!next) return;
    rows.find((r) => r.name === name)?.show(next); // only that field changes: what is typed in the others stays
    heading.textContent = next.fields.title || next.name;
  };
  const input = (type: "text" | "number" = "text") => el("input", { type, class: "card-input" });
  const area = (rows: number) => el("textarea", { rows, class: "card-input" });
  const titleInput = input();
  const authorsInput = area(3);
  const yearInput = input("number");
  yearInput.min = "0";
  yearInput.max = "3000";
  yearInput.step = "1";
  const seriesInput = input();
  const languageInput = input();
  languageInput.maxLength = 35;
  const tagsInput = input();
  const descriptionInput = area(5);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const rows: Row[] = [
    row("title", "card.titleField", null, titleInput, () => titleInput.value.trim(), text, undo),
    row("authors", "card.authors", "card.authorsHint", authorsInput, () => lines(authorsInput.value), (v) => (v as string[]).join("\n"), undo),
    row("year", "card.year", null, yearInput, () => (yearInput.value.trim() === "" ? null : Number(yearInput.value)), text, undo),
    row("series", "card.series", null, seriesInput, () => seriesInput.value.trim(), text, undo),
    row("language", "card.language", "card.languageHint", languageInput, () => languageInput.value.trim(), text, undo),
    row("tags", "card.tags", "card.tagsHint", tagsInput, () => tagsInput.value.split(",").map((x) => x.trim()).filter(Boolean), (v) => (v as string[]).join(", "), undo),
    row("description", "card.description", null, descriptionInput, () => descriptionInput.value.trim(), text, undo),
  ];
  const heading = el("span", { class: "card-heading" });
  // the tags already used by other books, to pick from: one spelling for one tag
  const picks = el("div", { class: "card-picks" });
  const typedTags = () => tagsInput.value.split(",").map((x) => x.trim()).filter(Boolean);
  const renderPicks = () => {
    const have = new Set(typedTags().map((x) => x.toLowerCase()));
    const left = known.filter((k) => !have.has(k.tag.toLowerCase())).slice(0, 12);
    picks.replaceChildren(
      ...(left.length ? [el("span", { class: "muted small", textContent: t("card.tagPicks") })] : []),
      ...left.map((k) => {
        const pick = el("button", { type: "button", class: "btn card-pick", textContent: `+ ${k.tag}`, title: t("card.tagPick") });
        pick.addEventListener("click", () => {
          tagsInput.value = [...typedTags(), k.tag].join(", ");
          tagsInput.dispatchEvent(new Event("input", { bubbles: true }));
        });
        return pick;
      }),
    );
  };
  tagsInput.addEventListener("input", renderPicks);
  rows.find((r) => r.name === "tags")!.node.append(picks);
  const show = (c: Card) => {
    for (const r of rows) r.show(c);
    renderPicks();
    heading.textContent = c.fields.title || c.name;
  };
  show(card);

  const save = el("button", { type: "submit", class: "btn primary", textContent: t("common.save") });
  const readPages = card.ext === "pdf" ? [el("button", { type: "button", class: "btn card-ocr", textContent: t("card.ocr") })] : []; // a scan can be read here, one book at a time
  readPages[0]?.addEventListener("click", () => void openOcr({ focus: { id, title: card.fields.title || card.name, path: card.path } }));
  const checkText = card.ext === "pdf" ? [el("button", { type: "button", class: "btn card-proof", textContent: t("card.proof") })] : []; // the scan beside its text, to correct it (or to write it)
  checkText[0]?.addEventListener("click", () => void openProof({ id, title: card.fields.title || card.name }));
  const form = el("form", { class: "card-form" }, ...rows.map((r) => r.node), el("div", { class: "row project-buttons" }, save, saved, ...readPages, ...checkText), error);
  form.noValidate = true; // the server's answer (in the reader's language) explains a bad value, not the browser's bubble
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const set: Record<string, unknown> = {};
    for (const r of rows) if (JSON.stringify(r.read()) !== JSON.stringify(card.fields[r.name])) set[r.name] = r.read();
    saved.hidden = true;
    if (Object.keys(set).length) {
      save.disabled = true;
      const next = await put({ set });
      save.disabled = false;
      if (!next) return;
      show(next);
    }
    saved.hidden = false;
  });
  form.addEventListener("input", () => (saved.hidden = true));
  modal.body.replaceChildren(el("div", { class: "reader-title" }, badge(card.ext), heading), form, file(), note);
}
