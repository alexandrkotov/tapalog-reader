import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

/** Why a request was not made or did not finish; the import maps these onto its own error codes. */
export class UnsafeAddress extends Error {
  constructor() {
    super("local-address");
  }
}

// Everything that is not an address on the public internet: this computer, private networks, link-local
// (cloud metadata), carrier-grade NAT, documentation and benchmarking ranges, multicast, reserved, and the
// IPv6 forms that carry an IPv4 address inside (mapped, NAT64, 6to4), which could be used to smuggle one past.
// Two lists, because a list that holds an IPv6 rule for mapped addresses (::ffff:0:0/96) would also match every IPv4 address.
const BLOCKED4 = new BlockList();
const BLOCKED6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED6.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  return !(family === 4 ? BLOCKED4.check(address, "ipv4") : BLOCKED6.check(address, "ipv6"));
}

type Lookup = (hostname: string, options: { all?: boolean }, callback: (err: Error | null, address?: unknown, family?: number) => void) => void;

/** Resolves a name for the connection itself, so the address that is checked is the address that is used. */
const guardedLookup =
  (allowed: (address: string) => boolean): Lookup =>
  (hostname, options, callback) => {
    dnsLookup(hostname, { all: true }).then(
      (found) => {
        if (!found.length || found.some((a) => !allowed(a.address))) return callback(new UnsafeAddress());
        if (options.all) callback(null, found);
        else callback(null, found[0]!.address, found[0]!.family);
      },
      (err: Error) => callback(err),
    );
  };

/**
 * One HTTP(S) request that only ever reaches public internet addresses: nothing on this computer or in
 * the local network, however the address is written or whatever a name resolves to. Redirects are not
 * followed (the caller checks each hop). Rejects with UnsafeAddress for a forbidden address. `allowed`
 * says which addresses are fine: the public ones, except in tests that talk to a server on this computer.
 */
export function safeGet(url: URL, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}, allowed: (address: string) => boolean = isPublicAddress): Promise<Response> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !allowed(host)) return Promise.reject(new UnsafeAddress()); // an address typed as a number is not resolved, so it is checked here
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = send(url, { method: "GET", headers: init.headers, signal: init.signal, lookup: guardedLookup(allowed) as never }, (res: IncomingMessage) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const status = res.statusCode ?? 502;
      const empty = status < 200 || [204, 205, 304].includes(status);
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers }));
    });
    req.on("error", (err) => reject(err));
    req.end();
  });
}
