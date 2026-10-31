import { networkInterfaces } from "node:os";
import { ConfigStore } from "./config";
import { openDb } from "./db";
import { resolveDataDir } from "./dataDir";
import { Library } from "./library";
import { openInBrowser } from "./openInBrowser";
import { startServer } from "./server";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = resolveDataDir(arg("data"));
const config = new ConfigStore(dataDir);
const library = new Library(openDb(dataDir), config, dataDir);

const libraryArg = arg("library");
if (libraryArg) await library.setRoot(libraryArg);
else await library.start();

const preferred = Number(arg("port") ?? process.env.PORT ?? 8920);
let server: ReturnType<typeof startServer> | null = null;
for (let port = preferred; port < preferred + 20 && !server; port++) {
  try {
    server = startServer(library, { hostname: arg("host") ?? "0.0.0.0", port });
  } catch (err) {
    if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
  }
}
if (!server) throw new Error(`no free port in ${preferred}-${preferred + 19}`);

const port = server.port;
const local = `http://localhost:${port}/`;
console.log(`Tapalog Reader  ${local}`);
for (const nets of Object.values(networkInterfaces()))
  for (const n of nets ?? []) if (n.family === "IPv4" && !n.internal) console.log(`   on the network  http://${n.address}:${port}/`);
console.log(`Data folder     ${dataDir}`);
console.log(library.root ? `Library         ${library.root}` : "Library         (not chosen yet — open the page and pick a folder)");

if (!process.argv.includes("--no-open")) openInBrowser(local);
