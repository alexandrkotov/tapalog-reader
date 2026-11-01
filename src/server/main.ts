import { networkInterfaces } from "node:os";
import { ConfigStore } from "./config";
import { cleanupExtracted } from "./embedCloudflared";
import { openDb } from "./db";
import { resolveDataDir } from "./dataDir";
import { Covers } from "./covers";
import { Library } from "./library";
import { openInBrowser } from "./openInBrowser";
import { Auth } from "./auth";
import { Shares } from "./shares";
import { startServers } from "./server";
import { TunnelController } from "./tunnelController";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = resolveDataDir(arg("data"));
const config = new ConfigStore(dataDir);
const db = openDb(dataDir);
const library = new Library(db, config, dataDir);
const auth = new Auth(db);
const shares = new Shares(db);
const covers = new Covers(dataDir);
library.onScan = () => covers.prune(new Set(library.books().map((b) => b.id)));

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

for (let port = preferred; port < preferred + 20 && !servers; port++) {
  try {
    servers = startServers({ library, auth, shares, config, covers, tunnel, lanUrls, setMode }, { hostname, port });
  } catch (err) {
    if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
  }
}
if (!servers) throw new Error(`no free port in ${preferred}-${preferred + 19}`);

const local = `http://localhost:${servers.lan.port}/`;
console.log(`Tapalog Reader  ${local}`);
for (const url of lanUrls()) console.log(`   on the network  ${url}/`);
console.log(`Data folder     ${dataDir}`);
console.log(library.root ? `Library         ${library.root}` : "Library         (not chosen yet — open the page and pick a folder)");

if (config.get().mode === "internet") {
  console.log("Internet        connecting a public tunnel…");
  tunnel.start();
}

const shutdown = () => {
  tunnel.stop();
  servers?.stop();
  process.exit(0); // the "exit" handler below removes the extracted cloudflared
};
process.on("exit", cleanupExtracted);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!process.argv.includes("--no-open")) openInBrowser(local);
