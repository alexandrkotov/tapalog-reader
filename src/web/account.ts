import { restoreFromFile } from "./backup";
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
  canRecover: boolean;
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

/** Forgotten administrator password: ask the server for a code, read it from the file in the data folder, type it back with a new password. */
function recoverPanel(done: () => void, back: () => void): HTMLElement {
  const box = el("div", { class: "stack" });
  const error = el("div", { class: "error" });
  const backButton = el("button", { type: "button", class: "link", textContent: t("recover.back") });
  backButton.addEventListener("click", back);

  const ask = el("button", { type: "button", class: "btn primary", textContent: t("recover.get") });
  ask.addEventListener("click", async () => {
    error.textContent = "";
    try {
      const sent = await api<{ file: string; path: string | null }>("/api/recover/start", {});
      showForm(sent.path ? t("recover.savedAt", { path: sent.path }) : t("recover.saved", { file: sent.file }));
    } catch (err) {
      error.textContent = errorText(err);
    }
  });

  function showForm(where: string): void {
    const name = el("input", { type: "text", autocomplete: "username", required: true });
    const code = el("input", { type: "text", inputMode: "numeric", autocomplete: "one-time-code", required: true, placeholder: "0000-0000" });
    const password = el("input", { type: "password", autocomplete: "new-password", required: true });
    const form = el(
      "form",
      { class: "stack" },
      el("p", { class: "muted", textContent: where }),
      el("label", {}, el("span", { textContent: t("common.name") }), name),
      el("label", {}, el("span", { textContent: t("recover.code") }), code),
      el("label", {}, el("span", { textContent: t("recover.newPassword") }), password),
      el("button", { type: "submit", class: "btn primary", textContent: t("recover.apply") }),
      error,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      try {
        await api("/api/recover/finish", { name: name.value, code: code.value, password: password.value });
        done();
      } catch (err) {
        error.textContent = err instanceof ApiError && err.status === 401 ? t("recover.wrong") : errorText(err);
      }
    });
    box.replaceChildren(form, backButton);
    name.focus();
  }

  box.append(el("p", { class: "muted", textContent: t("recover.text") }), ask, error, backButton);
  return box;
}

/** Sign-in with an optional switch to "create account" when the server allows it. */
export function authPanel(me: Me, done: () => void): HTMLElement {
  const box = el("div", { class: "stack" });
  const show = (kind: AuthKind) => {
    const switcher = me.canRegister
      ? el("button", { type: "button", class: "link", textContent: kind === "signIn" ? t("account.register") : t("account.signIn") })
      : null;
    switcher?.addEventListener("click", () => show(kind === "signIn" ? "register" : "signIn"));
    const forgot = me.canRecover && kind === "signIn" ? el("button", { type: "button", class: "link", textContent: t("account.forgot") }) : null;
    forgot?.addEventListener("click", () => box.replaceChildren(recoverPanel(done, () => show("signIn"))));
    box.replaceChildren(authForm(kind, done), ...(kind === "register" ? [el("p", { class: "muted", textContent: t("account.registerHint") })] : []), ...(switcher ? [switcher] : []), ...(forgot ? [forgot] : []));
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
  const result = el("div", { class: "error" });
  const restore = el("button", { type: "button", class: "link", textContent: t("setup.restore") });
  restore.addEventListener("click", () => restoreFromFile("/api/setup/restore", (text, ok) => ((result.className = ok ? "muted" : "error"), (result.textContent = text)), () => setTimeout(done, 800)));
  return el("div", { class: "message narrow" }, el("h2", { textContent: t("setup.title") }), el("p", { textContent: t("setup.text") }), authForm("setup", done), restore, result);
}

export async function signOut(): Promise<void> {
  await api("/api/logout", {});
}
