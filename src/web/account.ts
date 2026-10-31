import { t } from "./i18n";
import { api, ApiError, el, openModal } from "./ui";

export interface Me {
  user: { id: number; name: string; role: "admin" | "user" } | null;
  origin: "lan" | "tunnel";
  canBrowse: boolean;
  lanAccess: "open" | "login";
  setupNeeded: boolean;
  setupPossible: boolean;
  canRegister: boolean;
}

export type AuthKind = "signIn" | "register" | "setup";

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return t("account.wrong");
    if (err.status === 429) return t("account.locked");
    if (err.status === 409) return t("account.taken");
    if (err.status === 400) return t("account.short");
  }
  return err instanceof Error ? err.message : String(err);
}

/** One form for the three ways in: sign in, create an account, or (first run) create the administrator. */
export function authForm(kind: AuthKind, done: () => void): HTMLFormElement {
  const name = el("input", { type: "text", autocomplete: "username", required: true });
  const password = el("input", { type: "password", autocomplete: kind === "signIn" ? "current-password" : "new-password", required: true });
  const error = el("div", { class: "error" });
  const label = kind === "signIn" ? t("account.signIn") : kind === "register" ? t("account.register") : t("setup.button");
  const form = el(
    "form",
    { class: "stack" },
    el("label", {}, el("span", { textContent: t("common.name") }), name),
    el("label", {}, el("span", { textContent: t("common.password") }), password),
    el("button", { type: "submit", class: "btn primary", textContent: label }),
    error,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      await api(kind === "signIn" ? "/api/login" : kind === "register" ? "/api/register" : "/api/setup", { name: name.value, password: password.value });
      done();
    } catch (err) {
      error.textContent = errorText(err);
    }
  });
  queueMicrotask(() => name.focus());
  return form;
}

/** Sign-in with an optional switch to "create account" when the server allows it. */
export function authPanel(me: Me, done: () => void): HTMLElement {
  const box = el("div", { class: "stack" });
  const show = (kind: AuthKind) => {
    const switcher = me.canRegister
      ? el("button", { type: "button", class: "link", textContent: kind === "signIn" ? t("account.register") : t("account.signIn") })
      : null;
    switcher?.addEventListener("click", () => show(kind === "signIn" ? "register" : "signIn"));
    box.replaceChildren(authForm(kind, done), ...(kind === "register" ? [el("p", { class: "muted", textContent: t("account.registerHint") })] : []), ...(switcher ? [switcher] : []));
  };
  show("signIn");
  return box;
}

export function openAuthDialog(me: Me, done: () => void): void {
  const modal = openModal(t("account.signIn"));
  modal.body.append(
    authPanel(me, () => {
      modal.close();
      done();
    }),
  );
}

/** The sign-in screen shown in place of the library when nothing is open to anonymous visitors. */
export function authScreen(me: Me, done: () => void): HTMLElement {
  return el("div", { class: "message narrow" }, el("h2", { textContent: t("account.required") }), el("p", { textContent: t("account.requiredText") }), authPanel(me, done));
}

export function setupScreen(me: Me, done: () => void): HTMLElement {
  if (!me.setupPossible) return el("div", { class: "message" }, el("h2", { textContent: t("setup.title") }), el("p", { textContent: t("setup.remote") }));
  return el("div", { class: "message narrow" }, el("h2", { textContent: t("setup.title") }), el("p", { textContent: t("setup.text") }), authForm("setup", done));
}

export async function signOut(): Promise<void> {
  await api("/api/logout", {});
}
