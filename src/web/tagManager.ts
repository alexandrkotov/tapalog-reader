import { t } from "./i18n";
import type { TagInfo } from "./tags";
import { api, el, openModal } from "./ui";

export interface TagManagerSpec {
  /** The tags in use now, most books first. */
  read(): TagInfo[];
  /** Runs after a change was saved: the page reads the library again and redraws itself. */
  changed(): Promise<void>;
}

/**
 * The administrator's window for the tags of the whole library: rename one (a name already in use merges the two)
 * or take one away from every book. One change at a time, each confirmed where it cannot be undone by hand.
 */
export function openTagManager(spec: TagManagerSpec): void {
  const modal = openModal(t("tags.manage.title"));
  const list = el("div", { class: "tag-manage-list" });
  const status = el("p", { class: "muted small tag-manage-status", hidden: true });
  const error = el("p", { class: "project-missing", hidden: true });
  let editing: string | null = null; // the key of the tag being renamed

  const say = (text: string, bad = false) => {
    status.hidden = bad || !text;
    error.hidden = !bad || !text;
    (bad ? error : status).textContent = text;
  };
  const send = async (path: string, body: object): Promise<boolean> => {
    say("");
    try {
      const { changed } = await api<{ changed: number }>(path, body);
      await spec.changed();
      say(t("tags.manage.done", { n: changed }));
      return true;
    } catch {
      say(t("tags.manage.bad"), true);
      return false;
    }
  };

  function draw(): void {
    const tags = spec.read();
    if (!tags.length) return list.replaceChildren(el("p", { class: "muted", textContent: t("tags.manage.none") }));
    list.replaceChildren(
      ...tags.map((tag) => {
        if (tag.key === editing) {
          const input = el("input", { type: "text", class: "tag-manage-input", value: tag.label, maxLength: 80, autocomplete: "off" });
          input.setAttribute("aria-label", t("tags.manage.newName"));
          const save = el("button", { type: "button", class: "btn primary", textContent: t("common.save") });
          const cancel = el("button", { type: "button", class: "btn", textContent: t("common.cancel") });
          const submit = async () => {
            const name = input.value.trim();
            if (!name) return say(t("tags.manage.bad"), true);
            const other = tags.find((x) => x.key === name.toLowerCase() && x.key !== tag.key);
            if (other && !confirm(t("tags.manage.mergeAsk", { from: tag.label, to: other.label }))) return;
            if (await send("/api/admin/tags/rename", { from: tag.key, to: name })) {
              editing = null;
              draw();
            }
          };
          save.addEventListener("click", () => void submit());
          cancel.addEventListener("click", () => ((editing = null), say(""), draw()));
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.stopPropagation(); // closes the edit, not the window
              editing = null;
              draw();
            }
          });
          queueMicrotask(() => (input.focus(), input.select()));
          return el("div", { class: "tag-manage-row" }, input, save, cancel);
        }
        const rename = el("button", { type: "button", class: "btn tag-rename", textContent: t("tags.manage.rename") });
        rename.addEventListener("click", () => ((editing = tag.key), say(""), draw()));
        const remove = el("button", { type: "button", class: "btn tag-remove", textContent: t("tags.manage.remove") });
        remove.addEventListener("click", async () => {
          if (!confirm(t("tags.manage.removeAsk", { tag: tag.label, n: tag.count }))) return;
          if (await send("/api/admin/tags/remove", { tag: tag.key })) draw();
        });
        return el("div", { class: "tag-manage-row" }, el("span", { class: "tag-manage-name", textContent: tag.label }), el("span", { class: "tag-count", textContent: String(tag.count) }), rename, remove);
      }),
    );
  }

  modal.body.append(el("p", { class: "muted small", textContent: t("tags.manage.note") }), status, error, list);
  draw();
}
