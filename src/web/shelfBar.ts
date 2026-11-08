import { t, type Key } from "./i18n";
import type { TagInfo } from "./tags";
import { isFiltering, NO_FILTERS, SORT_KEYS, startsReversed, type Filters, type Prefs, type SortKey, type ViewKind } from "./shelfView";
import { el } from "./ui";

export interface BarSpec {
  prefs: Prefs;
  filters: Filters;
  /** The formats and tags of the books this shelf can show: the only values worth offering. */
  formats: { ext: string; count: number }[];
  tags: TagInfo[];
  /** The reader chose another layout or order. */
  onPrefs(prefs: Prefs): void;
  /** The reader changed what the shelf keeps. */
  onFilters(filters: Filters): void;
  /** Only the filters: no layout, no order (the page of search results has its own order). */
  filtersOnly?: boolean;
}

export interface Bar {
  node: HTMLElement;
  /** The line at the right end: how many books the filters let through. Empty hides it. */
  status(text: string): void;
}

const TYPING_DELAY = 200;

/** The bar above a shelf: cards or list, the order, and the filters (format, tag, author). */
export function shelfBarEl(spec: BarSpec): Bar {
  let prefs = { ...spec.prefs };
  let filters = { ...spec.filters };

  const views: [ViewKind, string, Key][] = [
    ["grid", "▦", "shelf.view.grid"],
    ["list", "☰", "shelf.view.list"],
  ];
  const viewButtons = views.map(([kind, icon, label]) => {
    const button = el("button", { type: "button", class: "btn bar-view", textContent: icon, title: t(label) });
    button.dataset.view = kind;
    button.setAttribute("aria-label", t(label));
    button.addEventListener("click", () => {
      if (prefs.view === kind) return;
      prefs = { ...prefs, view: kind };
      draw();
      spec.onPrefs(prefs);
    });
    return button;
  });

  const sort = el("select", { class: "bar-sort", title: t("shelf.sort") }, ...SORT_KEYS.map((key) => el("option", { value: key, textContent: t(`shelf.sort.${key}` as Key) })));
  sort.setAttribute("aria-label", t("shelf.sort"));
  sort.addEventListener("change", () => {
    const key = sort.value as SortKey;
    prefs = { ...prefs, sort: key, desc: startsReversed(key) };
    draw();
    spec.onPrefs(prefs);
  });
  const direction = el("button", { type: "button", class: "btn bar-direction", title: t("shelf.reverse") });
  direction.setAttribute("aria-label", t("shelf.reverse"));
  direction.addEventListener("click", () => {
    prefs = { ...prefs, desc: !prefs.desc };
    draw();
    spec.onPrefs(prefs);
  });

  const field = (label: Key, control: HTMLElement) => el("label", { class: "bar-field" }, el("span", { class: "muted small", textContent: t(label) }), control);
  const format = el("select", { class: "bar-format" }, el("option", { value: "", textContent: t("shelf.formatAll") }), ...spec.formats.map((f) => el("option", { value: f.ext, textContent: `${f.ext.toUpperCase()} (${f.count})` })));
  const tag = el("select", { class: "bar-tag" }, el("option", { value: "", textContent: t("shelf.tagAll") }), ...spec.tags.map((x) => el("option", { value: x.key, textContent: `${x.label} (${x.count})` })));
  const author = el("input", { type: "search", class: "bar-author", placeholder: t("shelf.authorPlaceholder") });
  const reset = el("button", { type: "button", class: "btn bar-reset", textContent: t("shelf.reset") });
  const status = el("span", { class: "muted small bar-status", hidden: true });

  const changed = () => {
    filters = { format: format.value, tag: tag.value, author: author.value };
    draw();
    spec.onFilters(filters);
  };
  format.addEventListener("change", changed);
  tag.addEventListener("change", changed);
  let typing: ReturnType<typeof setTimeout> | undefined;
  author.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(changed, TYPING_DELAY);
  });
  reset.addEventListener("click", () => {
    clearTimeout(typing);
    format.value = tag.value = author.value = "";
    filters = { ...NO_FILTERS };
    draw();
    spec.onFilters(filters);
  });

  /** Shows what is chosen. The filter controls are left alone: the reader may be typing in one. */
  const draw = () => {
    for (const button of viewButtons) {
      const on = button.dataset.view === prefs.view;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    sort.value = prefs.sort;
    direction.textContent = prefs.desc ? "↓" : "↑";
    reset.hidden = !isFiltering({ ...filters, author: author.value });
  };
  format.value = filters.format;
  tag.value = filters.tag;
  author.value = filters.author;
  draw();

  const node = el(
    "div",
    { class: "shelf-bar" },
    ...(spec.filtersOnly ? [] : [el("div", { class: "bar-group" }, ...viewButtons), el("div", { class: "bar-group" }, field("shelf.sort", sort), direction)]),
    el("div", { class: "bar-group bar-filters" }, field("shelf.format", format), ...(spec.tags.length ? [field("shelf.tag", tag)] : []), field("shelf.author", author), reset),
    status,
  );
  node.dataset.tour = "shelfbar";
  return {
    node,
    status(text) {
      status.textContent = text;
      status.hidden = !text;
    },
  };
}
