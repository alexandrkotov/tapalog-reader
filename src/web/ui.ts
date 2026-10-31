import { t } from "./i18n";

type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & { class?: string };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

/** localStorage may throw (private windows, blocked storage); the UI must work without it. */
export const store = {
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

export const badge = (ext: string) => el("span", { class: `badge badge-${ext}`, textContent: ext });

/** JSON call to our own API. Errors keep the status so callers can tell "sign in" from "name taken". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data;
}

export interface Modal {
  body: HTMLElement;
  close(): void;
}

/** A dialog over the page: Esc, the × and a click outside close it. */
export function openModal(title: string, onClose?: () => void): Modal {
  const body = el("div", { class: "modal-body" });
  const close = () => {
    backdrop.remove();
    removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  const box = el("div", { class: "modal", role: "dialog" }, el("div", { class: "modal-head" }, el("h2", { textContent: title }), el("button", { class: "icon-btn", type: "button", title: t("common.close"), textContent: "×", onclick: close })), body);
  box.setAttribute("aria-modal", "true");
  const backdrop = el("div", { class: "modal-backdrop" }, box);
  backdrop.addEventListener("mousedown", (e) => e.target === backdrop && close());
  addEventListener("keydown", onKey);
  document.body.append(backdrop);
  return { body, close };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el("textarea", { value: text });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
