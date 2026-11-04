import { networkInterfaces } from "node:os";
import { ConfigStore } from "./config";
import { cleanupExtracted } from "./embedCloudflared";
import { openDb } from "./db";
import { resolveDataDir } from "./dataDir";
import { Covers, registerCoverFormats } from "./covers";
import { LinkImports, driveEndpoints } from "./linkImport";
import { registerFormats } from "./formats";
import { defaultPluginsDir, Plugins } from "./plugins";
import { Sources } from "./sources";
import { LibraryEditor } from "./editor";
import { FullText } from "./fulltext";
import { Library } from "./library";
import { openInBrowser } from "./openInBrowser";
import { recordInstance, runningInstance } from "./instance";
import { Auth } from "./auth";
import { Backup } from "./backup";
import { Recovery } from "./recovery";
import { Bookmarks } from "./bookmarks";
import { ProgressStore } from "./progress";
import { Shares } from "./shares";
import { startServers } from "./server";
import { TunnelController } from "./tunnelController";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = resolveDataDir(arg("data"));

// started a second time: open the program that is already running instead of starting another one
const already = await runningInstance(dataDir);
if (already) {
  const url = `http://localhost:${already}/`;
  console.log(`Tapalog Reader is already running: ${url}`);
  if (!process.argv.includes("--no-open")) {
    openInBrowser(url);
    await Bun.sleep(300); // the browser's launcher gets going before this process ends
  }
  process.exit(0);
}

const config = new ConfigStore(dataDir);
const db = openDb(dataDir);
const library = new Library(db, config, dataDir);
const auth = new Auth(db);
const recovery = new Recovery(dataDir, auth);
const shares = new Shares(db);
const bookmarks = new Bookmarks(db);
const progress = new ProgressStore(db);
const backup = new Backup(db, config);
const editor = new LibraryEditor(library, dataDir);
const linkImports = new LinkImports(library, editor, driveEndpoints());
const covers = new Covers(dataDir);
const fullText = new FullText(dataDir, library, config);
library.onScan = () => {
  covers.prune(new Set(library.books().map((b) => b.id)));
  fullText.onScan();
};

const plugins = new Plugins(defaultPluginsDir(arg("plugins")));
registerFormats(plugins.formats());
registerCoverFormats(plugins.coverFormats());
for (const p of plugins.plugins) console.log(`   plugin          ${p.name} (${p.exts.map((e) => "." + e).join(", ")})`);
for (const p of plugins.problems) console.warn(`   plugin ${p.folder} skipped: ${p.problem}`);

const libraryArg = arg("library");
if (libraryArg) await library.setRoot(libraryArg);
else await library.start();

const preferred = Number(arg("port") ?? process.env.PORT ?? 8920);
const hostname = arg("host") ?? "0.0.0.0";
// Filled in once the sockets exist; the tunnel and the share dialog read them lazily.
let servers: ReturnType<typeof startServers> | null = null;
const lanUrls = () =>
  Object.values(networkInterfaces()).flatMap((nets) =>
    (nets ?? []).filter((n) => n.family === "IPv4" && !n.internal).map((n) => `http://${n.address}:${servers?.lan.port}`),
  );

const tunnel = new TunnelController(() => `http://127.0.0.1:${servers?.internal.port}`);
const setMode = (mode: "lan" | "internet") => {
  config.update({ mode });
  if (mode === "internet") tunnel.start();
  else tunnel.stop();
};

// The preferred port and the next 19. Windows can reserve whole ranges of ports for itself (Hyper-V, WSL, Docker), and
// which ones changes from one start of the computer to the next, so when nothing in that range can be used and the
// port was not asked for, the system is left to pick any free one instead of refusing to start.
const asked = arg("port") !== undefined || process.env.PORT !== undefined;
const candidates = [...Array.from({ length: 20 }, (_, i) => preferred + i), ...(asked ? [] : [0])];
for (const port of candidates) {
  if (servers) break;
  try {
    servers = startServers({ library, auth, recovery, shares, config, covers, bookmarks, progress, backup, editor, linkImports, sources: new Sources(db), plugins, fullText, tunnel, lanUrls, setMode, stop: () => shutdown() }, { hostname, port });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw err; // a port Windows keeps for itself is refused with EACCES
  }
}
if (!servers) throw new Error(`no free port in ${preferred}-${preferred + 19}`);
const bound = servers.lan.port ?? 0;
if (bound < preferred || bound > preferred + 19) console.log(`Ports ${preferred}-${preferred + 19} are not available on this computer, so ${bound} is used instead.`);

const local = `http://localhost:${servers.lan.port}/`;
console.log(`Tapalog Reader  ${local}`);
for (const url of lanUrls()) console.log(`   on the network  ${url}/`);
console.log(`Data folder     ${dataDir}`);
console.log(library.root ? `Library         ${library.root}` : "Library         (not chosen yet — open the page and pick a folder)");

fullText.kick(); // continues an unfinished index from the last run

if (config.get().mode === "internet") {
  console.log("Internet        connecting a public tunnel…");
  tunnel.start();
}

const forgetInstance = recordInstance(dataDir, servers.lan.port ?? 0);
const shutdown = () => {
  tunnel.stop();
  servers?.stop();
  process.exit(0); // the "exit" handler below removes the extracted cloudflared
};
process.on("exit", () => (forgetInstance(), cleanupExtracted()));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!process.argv.includes("--no-open")) openInBrowser(local);
