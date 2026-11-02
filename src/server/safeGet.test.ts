import { expect, test } from "bun:test";
import { isPublicAddress, safeGet, UnsafeAddress } from "./safeGet";

test("only addresses on the public internet count as public", () => {
  for (const ok of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.255.255", "100.63.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) expect(isPublicAddress(ok)).toBe(true);
  for (const no of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fd12:3456::1", "fc00::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "::127.0.0.1",
    "localhost", "not an address", "",
  ]) expect(isPublicAddress(no)).toBe(false);
});

test("a request to this computer is refused however its address is written, before any connection", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("secret") });
  try {
    for (const host of ["127.0.0.1", "localhost", "[::1]", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.1", "[::ffff:127.0.0.1]", "0.0.0.0"]) {
      let error: unknown;
      await safeGet(new URL(`http://${host}:${server.port}/`)).catch((err) => (error = err));
      expect(error).toBeInstanceOf(UnsafeAddress);
    }
  } finally {
    server.stop(true);
  }
});

test("when the address is allowed the response comes through whole: status, headers and body", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname === "/gone" ? new Response(null, { status: 304 }) : new Response("hello", { status: 201, headers: { "X-One": "1", "Content-Type": "text/plain" } })),
  });
  try {
    const res = await safeGet(new URL(`http://localhost:${server.port}/`), { headers: { Range: "bytes=0-0" } }, () => true);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-one")).toBe("1");
    expect(await res.text()).toBe("hello");
    expect((await safeGet(new URL(`http://127.0.0.1:${server.port}/gone`), {}, () => true)).status).toBe(304);
    const stopped = new AbortController();
    stopped.abort();
    await expect(safeGet(new URL(`http://127.0.0.1:${server.port}/`), { signal: stopped.signal }, () => true)).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});
