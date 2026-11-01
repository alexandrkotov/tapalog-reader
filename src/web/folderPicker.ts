import { t } from "./i18n";
import { api, el, openModal } from "./ui";

export interface Listing {
  path: string;
  parent: string | null;
  sep: string;
  home: string;
  dirs: string[];
  books: number;
  truncated: boolean;
}

/** The folders of the computer that runs the server (the browser cannot see them: it only ever gets a file's contents). */
export const listFolders = (path?: string) => api<Listing>(`/api/admin/fs/browse${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`);

/** A path to show as an example in the kind this computer uses (C:\Users\Alex\Books, /home/alex/Books). */
export async function examplePath(): Promise<string> {
  try {
    const { home, sep } = await listFolders();
    return `${home}${sep}Books`;
  } catch {
    return "";
  }
}

/**
 * A folder chooser that works the same on every system: shows the folders of the server's computer,
 * starting at `start` (or the home folder when that is not a folder), and answers with the full path
 * of the one chosen, or null.
 */
export function pickFolder(start: string): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const modal = openModal(t("folder.title"), () => resolve(chosen));
    const where = el("div", { class: "folder-where" });
    const list = el("div", { class: "move-list folder-list" });
    const note = el("p", { class: "muted small" });
    const choose = el("button", { type: "button", class: "btn primary", textContent: t("folder.choose") });
    const home = el("button", { type: "button", class: "btn", textContent: `⌂ ${t("folder.home")}` });
    const up = el("button", { type: "button", class: "btn", textContent: `↑ ${t("folder.up")}` });
    modal.body.append(el("div", { class: "row" }, home, up), where, list, note, el("div", { class: "row" }, choose));

    let current: Listing | null = null;
    const join = (dir: string, name: string) => (dir === "" || /[\\/]$/.test(dir) ? dir + name : dir + (current?.sep ?? "/") + name);

    async function go(path?: string): Promise<void> {
      let listing: Listing;
      try {
        listing = await listFolders(path);
      } catch {
        if (path === undefined) return void (note.textContent = t("folder.error"));
        note.textContent = t("folder.error");
        return go(); // not a folder (any more): start again from home
      }
      current = listing;
      where.textContent = listing.path || t("folder.drives");
      up.disabled = listing.parent === null;
      choose.disabled = listing.path === "";
      note.textContent = listing.path === "" ? "" : listing.dirs.length ? t("folder.books", { n: listing.books }) : `${t("folder.empty")} ${t("folder.books", { n: listing.books })}`;
      list.replaceChildren(
        ...listing.dirs.map((name) => {
          const row = el("button", { type: "button", class: "link move-row", textContent: `📁 ${name}` });
          row.addEventListener("click", () => void go(listing.path === "" ? name : join(listing.path, name)));
          return row;
        }),
      );
    }

    home.addEventListener("click", () => void go());
    up.addEventListener("click", () => {
      if (current && current.parent !== null) void go(current.parent);
    });
    choose.addEventListener("click", () => {
      chosen = current?.path || null;
      modal.close();
    });
    void go(start || undefined);
  });
}
