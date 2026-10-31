import type { Database } from "bun:sqlite";

export interface User {
  id: number;
  name: string;
  role: "admin" | "user";
}

const SESSION_DAYS = 30;
const COOKIE = "sid";
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const randomToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

export function validateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 32 && !/[\u0000-\u001f\u007f<>]/.test(trimmed) ? trimmed : null;
}

export function validatePassword(password: unknown): string | null {
  return typeof password === "string" && password.length >= 4 && password.length <= 200 ? password : null;
}

/** Accounts, sessions and the brute-force brake. Passwords are argon2id hashes; a session cookie is random and stored only as its sha256. */
export class Auth {
  private fails = new Map<string, { count: number; until: number }>();
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly db: Database) {}

  userCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  async createUser(name: string, password: string, role: User["role"]): Promise<User> {
    const hash = await Bun.password.hash(password);
    const row = this.db.query("INSERT INTO users (name, hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING id, name, role").get(name, hash, role, Date.now());
    return row as User;
  }

  listUsers(): (User & { createdAt: number })[] {
    return (this.db.query("SELECT id, name, role, created_at AS createdAt FROM users ORDER BY name").all() as (User & { createdAt: number })[]);
  }

  /** Refuses to remove the last administrator: that would lock everyone out of the settings. */
  deleteUser(id: number): "ok" | "last-admin" | "missing" {
    const user = this.db.query("SELECT role FROM users WHERE id = ?").get(id) as { role: string } | null;
    if (!user) return "missing";
    if (user.role === "admin" && (this.db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n <= 1) return "last-admin";
    this.db.query("DELETE FROM users WHERE id = ?").run(id);
    return "ok";
  }

  async setPassword(id: number, password: string): Promise<boolean> {
    const hash = await Bun.password.hash(password);
    const changed = this.db.query("UPDATE users SET hash = ? WHERE id = ?").run(hash, id).changes > 0;
    if (changed) this.db.query("DELETE FROM sessions WHERE user_id = ?").run(id); // a changed password signs the account out everywhere
    return changed;
  }

  /** `key` identifies who is trying (client address + name) so one guesser can't lock out everybody. */
  locked(key: string): boolean {
    const f = this.fails.get(key);
    return !!f && f.count >= MAX_FAILS && f.until > Date.now();
  }

  async verify(name: string, password: string, key: string): Promise<User | null> {
    if (this.locked(key)) return null;
    const row = this.db.query("SELECT id, name, role, hash FROM users WHERE name = ?").get(name) as (User & { hash: string }) | null;
    // Check against a real hash even for an unknown name, so the response time doesn't reveal which names exist.
    this.dummyHash ??= Bun.password.hash(randomToken());
    const ok = await Bun.password.verify(password, row?.hash ?? (await this.dummyHash)).catch(() => false);
    if (!row || !ok) {
      const f = this.fails.get(key) ?? { count: 0, until: 0 };
      f.count = f.until > Date.now() || f.count < MAX_FAILS ? f.count + 1 : 1;
      f.until = Date.now() + LOCK_MS;
      this.fails.set(key, f);
      return null;
    }
    this.fails.delete(key);
    return { id: row.id, name: row.name, role: row.role };
  }

  /** Returns the cookie value to hand to the browser. */
  startSession(userId: number): { token: string; maxAgeSeconds: number } {
    this.db.query("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    const token = randomToken();
    const maxAgeSeconds = SESSION_DAYS * 86400;
    this.db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, Date.now() + maxAgeSeconds * 1000);
    return { token, maxAgeSeconds };
  }

  private cookieValue(req: Request): string | null {
    const header = req.headers.get("cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
    }
    return null;
  }

  userFor(req: Request): User | null {
    const token = this.cookieValue(req);
    if (!token) return null;
    const row = this.db
      .query("SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .get(sha256(token), Date.now()) as User | null;
    return row ?? null;
  }

  endSession(req: Request): void {
    const token = this.cookieValue(req);
    if (token) this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
  }

  clearCookie(secure: boolean): string {
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
  }
}
