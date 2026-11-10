// @ts-nocheck — the bridge is a plain script that is served as it is; `with { type: "file" }` makes `bun build --compile` embed it
import bridge from "./pluginBridge.js" with { type: "file" };

/** The file of the script that runs inside an isolated plugin's frame (see pluginBridge.js). */
export const BRIDGE_FILE: string = bridge;
