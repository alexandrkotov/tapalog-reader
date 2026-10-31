import { t } from "./i18n";
import { api, ApiError, el, openModal } from "./ui";

interface Settings {
  libraryPath: string | null;
  lanAccess: "open" | "login";
  allowRegistration: boolean;
  mode: "lan" | "internet";
  tunnel: { state: "off" | "starting" | "on" | "error"; url: string | null; error: string | null };
  users: { id: number; name: string; role: "admin" | "user" }[];
}

/** The administrator's panel: library folder, who may browse, the internet tunnel, accounts. */
export async function openAdmin(me: { id: number }, onLibraryChanged: () => void): Promise<void> {
  const modal = openModal(t("admin.title"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = modal.close;
  modal.close = () => {
    clearTimeout(timer);
    stop();
  };

  const section = (title: string, ...children: (Node | string)[]) => el("section", { class: "section" }, el("h3", { textContent: title }), ...children);
  const note = (text: string) => el("p", { class: "muted", textContent: text });
  const post = async (patch: object): Promise<Settings> => api<Settings>("/api/admin/settings", patch);

  function render(s: Settings): void {
    clearTimeout(timer);
    if (s.tunnel.state === "starting") timer = setTimeout(() => void api<Settings>("/api/admin/settings").then(render), 1500);

    // library
    const path = el("input", { type: "text", value: s.libraryPath ?? "" });
    const libError = el("div", { class: "error" });
    const useFolder = el("button", { type: "button", class: "btn", textContent: t("library.button") });
    useFolder.addEventListener("click", async () => {
      libError.textContent = "";
      try {
        await api("/api/library/path", { path: path.value.trim() });
        onLibraryChanged();
      } catch (err) {
        libError.textContent = err instanceof ApiError && err.status === 400 ? t("library.error") : String(err);
      }
    });
    const rescan = el("button", { type: "button", class: "btn", textContent: t("admin.rescan") });
    rescan.addEventListener("click", async () => {
      await api("/api/rescan", {});
      onLibraryChanged();
    });

    // access
    const radio = (value: "open" | "login", label: string) => {
      const input = el("input", { type: "radio", name: "lan", checked: s.lanAccess === value });
      input.addEventListener("change", async () => render(await post({ lanAccess: value })));
      return el("label", { class: "choice" }, input, label);
    };
    const registration = el("input", { type: "checkbox", checked: s.allowRegistration });
    registration.addEventListener("change", async () => render(await post({ allowRegistration: registration.checked })));

    // internet
    const internet = el("input", { type: "checkbox", checked: s.mode === "internet" });
    internet.addEventListener("change", async () => render(await post({ mode: internet.checked ? "internet" : "lan" })));
    const tunnelStatus =
      s.tunnel.state === "starting"
        ? el("p", { class: "muted", textContent: t("admin.internet.starting") })
        : s.tunnel.state === "on" && s.tunnel.url
          ? el("p", {}, `${t("admin.internet.address")}: `, el("a", { href: s.tunnel.url, target: "_blank", rel: "noopener", textContent: s.tunnel.url }))
          : s.tunnel.state === "error"
            ? el("p", { class: "error", textContent: s.tunnel.error ?? "" })
            : el("span");

    // accounts
    const users = s.users.map((u) => {
      const pw = el("input", { type: "password", placeholder: t("admin.users.password"), autocomplete: "new-password" });
      const setPw = el("button", { type: "button", class: "btn", textContent: t("admin.users.setPassword") });
      setPw.addEventListener("click", async () => {
        if (!pw.value) return;
        await api(`/api/admin/users/${u.id}/password`, { password: pw.value }).catch((e: unknown) => alert(String(e)));
        pw.value = "";
      });
      const del = el("button", { type: "button", class: "btn", textContent: t("common.delete"), disabled: u.id === me.id });
      del.addEventListener("click", async () => render(await api<Settings>(`/api/admin/users/${u.id}`, undefined, "DELETE").catch(() => s)));
      return el("div", { class: "user-row" }, el("span", { class: "grow", textContent: u.name }), el("span", { class: "muted", textContent: u.role === "admin" ? t("admin.users.admin") : t("admin.users.reader") }), pw, setPw, del);
    });
    const newName = el("input", { type: "text", placeholder: t("common.name"), autocomplete: "off" });
    const newPass = el("input", { type: "password", placeholder: t("common.password"), autocomplete: "new-password" });
    const newRole = el("select", {}, el("option", { value: "user", textContent: t("admin.users.reader") }), el("option", { value: "admin", textContent: t("admin.users.admin") }));
    const addError = el("div", { class: "error" });
    const add = el("button", { type: "button", class: "btn", textContent: t("admin.users.add") });
    add.addEventListener("click", async () => {
      addError.textContent = "";
      try {
        render(await api<Settings>("/api/admin/users", { name: newName.value, password: newPass.value, role: newRole.value }));
      } catch (err) {
        addError.textContent = err instanceof ApiError && err.status === 409 ? t("account.taken") : t("account.short");
      }
    });

    modal.body.replaceChildren(
      section(t("admin.library"), el("div", { class: "row" }, path, useFolder, rescan), libError),
      section(t("admin.access"), radio("open", t("admin.access.open")), radio("login", t("admin.access.login")), el("label", { class: "choice" }, registration, t("admin.register"))),
      section(t("admin.internet"), el("label", { class: "choice" }, internet, s.mode === "internet" ? t("admin.internet.on") : t("admin.internet.off")), tunnelStatus, note(t("admin.internet.note"))),
      section(t("admin.users"), ...users, el("div", { class: "user-row" }, newName, newPass, newRole, add), addError),
    );
  }

  render(await api<Settings>("/api/admin/settings"));
}
