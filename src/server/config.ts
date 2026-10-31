import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  /** Absolute path of the folder with the books; null until the admin picks one. */
  libraryPath: string | null;
  /** "lan" serves on the local network only; "internet" will add a public tunnel. */
  mode: "lan" | "internet";
  /** "open": anyone on the local network can browse; "login": sign-in required there too. Over the internet tunnel sign-in is always required. */
  lanAccess: "open" | "login";
  /** Whether visitors on the local network may create their own account (never over the tunnel: the admin creates those). */
  allowRegistration: boolean;
}

const DEFAULTS: Config = { libraryPath: null, mode: "lan", lanAccess: "open", allowRegistration: true };

export class ConfigStore {
  private readonly file: string;
  private value: Config;

  constructor(dataDir: string) {
    this.file = join(dataDir, "config.json");
    this.value = this.read();
  }

  private read(): Config {
    if (!existsSync(this.file)) return { ...DEFAULTS };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<Config>;
      return {
        libraryPath: typeof raw.libraryPath === "string" ? raw.libraryPath : null,
        mode: raw.mode === "internet" ? "internet" : "lan",
        lanAccess: raw.lanAccess === "login" ? "login" : "open",
        allowRegistration: raw.allowRegistration !== false,
      };
    } catch {
      return { ...DEFAULTS }; // corrupt file: start fresh rather than refuse to run
    }
  }

  get(): Config {
    return this.value;
  }

  update(patch: Partial<Config>): Config {
    this.value = { ...this.value, ...patch };
    writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.value;
  }
}
