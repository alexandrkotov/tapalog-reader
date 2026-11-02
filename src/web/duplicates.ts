import { t, type Key } from "./i18n";
import { api, ApiError, badge, el, formatBytes, openModal } from "./ui";

interface Item {
  id: string;
  path: string;
  ext: string;
  size: number;
  mtime: number;
}

interface Found {
  exact: { items: Item[] }[];
  similar: { items: Item[] }[];
}

const ERRORS: Record<string, Key> = { "last-copy": "dup.err.lastCopy", missing: "edit.err.missing", "read-only": "edit.err.readOnly" };

/**
 * Books stored twice: identical files (to keep one of, the rest going to the trash) and different
 * files with alike names (only to look at, then perhaps the same). Nothing is deleted: "the trash"
 * is a hidden folder inside the library.
 */
export function openDuplicates(opts: { changed: () => void; open: (bookId: string) => void }): void {
  const modal = openModal(t("dup.title"));
  let writable = true;

  async function search(message = ""): Promise<void> {
    modal.body.replaceChildren(el("p", { class: "muted", textContent: t("dup.looking") }));
    try {
      writable = (await api<{ writable?: boolean }>("/api/status")).writable !== false;
      draw(await api<Found>("/api/admin/duplicates", {}), message);
    } catch {
      modal.body.replaceChildren(el("div", { class: "error", textContent: t("edit.err.failed") }));
    }
  }

  function draw(found: Found, message: string): void {
    const checks: { path: string; box: HTMLInputElement }[] = [];
    const trash = el("button", { type: "button", class: "btn primary" });
    const error = el("div", { class: "error" });
    const update = () => {
      const n = checks.filter((c) => c.box.checked).length;
      trash.textContent = t("dup.trash", { n });
      trash.disabled = n === 0 || !writable;
    };

    const group = (items: Item[], exact: boolean) => {
      const boxes: HTMLInputElement[] = [];
      const rows = items.map((item, i) => {
        const box = el("input", { type: "checkbox", checked: exact && i > 0 }); // in a group of identical files the first stays
        boxes.push(box);
        checks.push({ path: item.path, box });
        box.addEventListener("change", () => {
          if (exact && boxes.every((b) => b.checked)) box.checked = false; // one copy always stays
          update();
        });
        const open = el("button", { type: "button", class: "btn small", textContent: t("dup.open") });
        open.addEventListener("click", () => {
          modal.close();
          opts.open(item.id);
        });
        return el(
          "label",
          { class: "dup-row" },
          box,
          badge(item.ext),
          el("span", { class: "dup-path", textContent: item.path, title: item.path }),
          el("span", { class: "muted small", textContent: `${formatBytes(item.size)} · ${new Date(item.mtime).toLocaleDateString()}` }),
          open,
        );
      });
      return el("div", { class: "dup-group" }, ...rows);
    };
    const section = (title: Key, note: Key, groups: { items: Item[] }[], exact: boolean) =>
      groups.length ? [el("h3", { class: "dup-title", textContent: `${t(title)} · ${groups.length}` }), el("p", { class: "muted small dup-note", textContent: t(note) }), ...groups.map((g) => group(g.items, exact))] : [];

    trash.addEventListener("click", async () => {
      const paths = checks.filter((c) => c.box.checked).map((c) => c.path);
      if (!paths.length || !confirm(t("dup.confirm", { n: paths.length }))) return;
      trash.disabled = true;
      try {
        const { trashed } = await api<{ trashed: number }>("/api/admin/duplicates/trash", { paths });
        opts.changed();
        await search(t("dup.done", { n: trashed }));
      } catch (err) {
        error.textContent = t(ERRORS[err instanceof ApiError ? err.message : ""] ?? "edit.err.failed");
        update();
      }
    });

    const nothing = !found.exact.length && !found.similar.length;
    modal.body.replaceChildren(
      ...(message ? [el("p", { textContent: message })] : []),
      ...(nothing ? [el("p", { class: "muted", textContent: t("dup.none") })] : []),
      ...section("dup.exact", "dup.exactNote", found.exact, true),
      ...section("dup.similar", "dup.similarNote", found.similar, false),
      ...(nothing ? [] : [el("div", { class: "dup-actions" }, trash, ...(writable ? [] : [el("span", { class: "muted small", textContent: t("edit.readOnlyLibrary") })]), error)]),
    );
    update();
  }

  void search();
}
