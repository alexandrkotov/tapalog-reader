import { t } from "./i18n";
import { api, ApiError } from "./ui";

const ERRORS: Record<string, Parameters<typeof t>[0]> = {
  "not-backup": "backup.err.notBackup",
  version: "backup.err.version",
  invalid: "backup.err.invalid",
  "no-admin": "backup.err.noAdmin",
  "too-big": "backup.err.tooBig",
};

/**
 * Lets the person pick a backup file and sends it to the server. `url` is the administrator's restore
 * (which asks first, since it replaces everything) or the first-run one (nothing to lose yet).
 * Reports back in words, and calls `done` after a successful restore.
 */
export function restoreFromFile(url: "/api/admin/restore" | "/api/setup/restore", report: (text: string, ok: boolean) => void, done: () => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return report(t("backup.err.notBackup"), false);
    }
    if ((data as { format?: unknown } | null)?.format !== "tapalog-reader-backup") return report(t("backup.err.notBackup"), false); // no need to ask before refusing
    if (url === "/api/admin/restore" && !confirm(t("backup.confirm"))) return;
    try {
      const res = await api<{ users: number; bookmarks: number; shares: number }>(url, data);
      report(t("backup.done", { users: res.users, bookmarks: res.bookmarks, shares: res.shares }), true);
      done();
    } catch (err) {
      report(err instanceof ApiError ? t(ERRORS[err.message] ?? "backup.err.invalid") : t("backup.err.read"), false);
    }
  });
  input.click();
}
