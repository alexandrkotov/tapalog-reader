import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Auth, User } from "./auth";

export const RESET_FILE = "reset-code.txt";
const CODE_MS = 15 * 60_000;
const MAX_FAILS = 5; // wrong codes from one visitor before they must wait
const LOCK_MS = 60_000;
const MAX_FAILS_ALL = 30; // wrong codes from everybody together: the code is then burned

/**
 * A forgotten administrator password is reset by proving access to the computer's data folder, the
 * same trust that lets the first administrator be created there: the sign-in page asks the server
 * for a code, the server writes it into a file in the data folder and only a person who can open
 * that file can type it back. The code lives in memory and in that file, for fifteen minutes.
 */
export class Recovery {
  private code: { value: string; until: number; fails: number } | null = null;
  private fails = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly dataDir: string,
    private readonly auth: Auth,
    private readonly now: () => number = Date.now,
  ) {
    rmSync(this.file, { force: true }); // a code left by an earlier run means nothing: it was only ever kept in memory
  }

  get file(): string {
    return join(this.dataDir, RESET_FILE);
  }

  private live(): boolean {
    if (this.code && this.code.until <= this.now()) this.burn();
    return this.code !== null;
  }

  private burn(): void {
    this.code = null;
    rmSync(this.file, { force: true });
  }

  /** Writes a code into the file. While one is still valid it is kept, so a stranger can't keep replacing the one the administrator is about to read. */
  start(): void {
    if (this.live()) return;
    const digits = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000).padStart(8, "0");
    this.code = { value: digits, until: this.now() + CODE_MS, fails: 0 };
    writeFileSync(
      this.file,
      `Tapalog Reader password reset code: ${digits.slice(0, 4)}-${digits.slice(4)}\n` +
        `Enter it on the sign-in page with the administrator's name and a new password. It works for 15 minutes.\n` +
        `Код для сброса пароля Tapalog Reader: ${digits.slice(0, 4)}-${digits.slice(4)}. Введите его на странице входа вместе с именем администратора и новым паролем. Действует 15 минут.\n`,
    );
  }

  /** `key` identifies who is trying, so one guesser can't lock the administrator out. */
  async finish(name: string, code: string, password: string, key: string): Promise<{ user: User } | "locked" | "wrong"> {
    const f = this.fails.get(key);
    if (f && f.count >= MAX_FAILS && f.until > this.now()) return "locked";
    const admin = this.auth.byName(name);
    const typed = Buffer.from(code.replace(/\D/g, ""));
    const wanted = Buffer.from(this.live() ? this.code!.value : "");
    if (!wanted.length || typed.length !== wanted.length || !timingSafeEqual(typed, wanted) || admin?.role !== "admin") {
      const entry = f && f.until > this.now() ? f : { count: 0, until: 0 };
      entry.count++;
      entry.until = this.now() + LOCK_MS;
      this.fails.set(key, entry);
      if (this.code && ++this.code.fails >= MAX_FAILS_ALL) this.burn();
      return "wrong";
    }
    this.burn();
    this.fails.clear();
    await this.auth.setPassword(admin.id, password);
    return { user: admin };
  }
}
