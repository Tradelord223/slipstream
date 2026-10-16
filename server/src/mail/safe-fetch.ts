import dns from "node:dns";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * The one way the server reaches out to a host named by someone else's email.
 * https on port 443 only, no cookies, no credentials, no Referer; every address that is connected to is
 * checked against the non-public ranges; redirects are followed by hand and re-checked; size and time are capped.
 */

const USER_AGENT = "Slipstream (sender logos)";
export const REQUEST_TIMEOUT_MS = 4_000;
export const MAX_REDIRECTS = 3;

// --- Addresses ---------------------------------------------------------------------------------

type V4 = [number, number, number, number];

function parseV4(s: string): V4 | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    out.push(Number(p));
  }
  return out as V4;
}

function parseV6(input: string): number[] | null {
  if (input.includes("%")) return null;
  let s = input;
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...new Array<number>(fill).fill(0), ...tail] : null;
}

function blockedV4([a, b, c]: V4): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved, broadcast
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments, documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** True for anything that is not an ordinary public internet address. Unparseable input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return blockedV4(v4);
  const g = parseV6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number): V4 => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, which also covers :: and ::1) are judged by the v4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embedded(g[6]!, g[7]!));
  // Only global unicast 2000::/3 is left; this drops fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 and the rest.
  if ((g[0]! & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2002) return blockedV4(embedded(g[1]!, g[2]!)); // 6to4 wraps a v4 address
  if (g[0] === 0x2001 && (g[1]! < 0x200 || g[1] === 0x0db8)) return true; // protocol assignments (Teredo...), documentation
  if (g[0] === 0x3fff && g[1]! < 0x1000) return true; // documentation
  return false;
}

export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolve: Resolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * A `lookup` for the https agent. It runs on the address that is then connected to, so a name that answers
 * differently the second time (DNS rebinding) cannot slip past a check made earlier. One bad answer refuses the host.
 */
export function guardedLookup(resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        if (found.length === 0 || found.some((f) => isBlockedAddress(f.address))) {
          callback(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: "EBLOCKED" }) as NodeJS.ErrnoException, "", 0);
          return;
        }
        const wanted = options.family === 4 || options.family === 6 ? found.filter((f) => f.family === options.family) : found;
        if (wanted.length === 0) {
          callback(Object.assign(new Error(`${hostname} has no usable address`), { code: "ENOTFOUND" }) as NodeJS.ErrnoException, "", 0);
        } else if (options.all) {
          callback(null, wanted.map((f) => ({ address: f.address, family: f.family })) as never);
        } else {
          callback(null, wanted[0]!.address, wanted[0]!.family);
        }
      },
      (err) => callback(err as NodeJS.ErrnoException, "", 0),
    );
  };
}

// --- URLs --------------------------------------------------------------------------------------

const REFUSED_SUFFIXES = new Set(["local", "internal", "localhost", "example", "test", "invalid", "onion", "lan", "home", "corp", "intranet", "private", "localdomain", "arpa"]);

/** A public-looking DNS name: letters, digits and hyphens in at least two labels, not an IP, not a private-use suffix. */
export function isPublicHostname(host: string): boolean {
  if (host.length > 253 || isIP(host) !== 0) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  const tld = labels[labels.length - 1]!;
  return !/^\d+$/.test(tld) && !REFUSED_SUFFIXES.has(tld);
}

export class FetchError extends Error {
  readonly kind: "invalid" | "blocked" | "network" | "timeout" | "status" | "redirect" | "size";
  constructor(kind: FetchError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
  /** The remote side answered (or was refused by us), as opposed to the network not getting through. */
  get reached(): boolean {
    return this.kind !== "network" && this.kind !== "timeout";
  }
}

function checkUrl(input: string | URL, allowHost?: (host: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError("invalid", "Not a URL");
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) throw new FetchError("invalid", "Only plain https on port 443");
  if (!isPublicHostname(url.hostname)) throw new FetchError("blocked", "Not a public host name");
  if (allowHost && !allowHost(url.hostname)) throw new FetchError("redirect", "Left the allowed domain");
  return url;
}

// --- Transport and fetcher ---------------------------------------------------------------------

export interface TransportResponse {
  status: number;
  /** Lowercase names; only location, content-length and content-type are filled in. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export type Transport = (url: URL, opts: { signal: AbortSignal; accept: string }) => Promise<TransportResponse>;

/** node:https with the guarded lookup, a fresh connection per request (no keep-alive, no cookie jar). */
export function httpsTransport(resolve?: Resolve): Transport {
  const lookup = guardedLookup(resolve);
  return (url, { signal, accept }) =>
    new Promise((done, fail) => {
      const req = https.request(
        {
          protocol: "https:",
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: "GET",
          agent: false,
          lookup,
          signal,
          headers: { "user-agent": USER_AGENT, accept, "accept-encoding": "identity" },
        },
        (res) => {
          const one = (name: string) => {
            const v = res.headers[name];
            return Array.isArray(v) ? v[0] : v;
          };
          done({
            status: res.statusCode ?? 0,
            headers: { location: one("location"), "content-length": one("content-length"), "content-type": one("content-type") },
            body: res,
            close: () => res.destroy(),
          });
        },
      );
      // Belt and braces: whatever the lookup said, refuse to talk to a socket that landed on a non-public address.
      req.on("socket", (socket) => {
        const check = () => {
          if (isBlockedAddress(socket.remoteAddress ?? "")) req.destroy(Object.assign(new Error("Connected to a non-public address"), { code: "EBLOCKED" }));
        };
        if (socket.connecting) socket.once("connect", check);
        else check();
      });
      req.on("error", fail);
      req.end();
    });
}

export interface SafeFetchOptions {
  /** Overall deadline for this call (every hop). Each request also gets its own 4 seconds. */
  signal: AbortSignal;
  maxBytes: number;
  accept: string;
  /** Keep the first `maxBytes` and stop, instead of refusing a larger response. */
  truncate?: boolean;
  /** Hosts a redirect may land on (the start URL included). Unset means any public host. */
  allowHost?: (host: string) => boolean;
}
export interface SafeFetchResult {
  url: URL;
  body: Buffer;
  truncated: boolean;
}
export type SafeFetch = (url: string | URL, opts: SafeFetchOptions) => Promise<SafeFetchResult>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function makeSafeFetch(transport: Transport): SafeFetch {
  return async (start, opts) => {
    let url = checkUrl(start, opts.allowHost);
    for (let hop = 0; ; hop++) {
      const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      let res: TransportResponse;
      try {
        res = await transport(url, { signal, accept: opts.accept });
      } catch (err) {
        throw asFetchError(err, signal);
      }
      try {
        if (REDIRECTS.has(res.status)) {
          if (hop >= MAX_REDIRECTS) throw new FetchError("redirect", "Too many redirects");
          const location = res.headers.location;
          if (!location) throw new FetchError("redirect", "Redirect without a location");
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new FetchError("redirect", "Bad redirect location");
          }
          url = checkUrl(next, opts.allowHost);
          continue;
        }
        if (res.status !== 200) throw new FetchError("status", `Answered ${res.status}`);
        const declared = Number(res.headers["content-length"]);
        if (!opts.truncate && Number.isFinite(declared) && declared > opts.maxBytes) throw new FetchError("size", "Response is too large");
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        for await (const chunk of res.body) {
          signal.throwIfAborted();
          total += chunk.length;
          if (total > opts.maxBytes) {
            if (!opts.truncate) throw new FetchError("size", "Response is too large");
            chunks.push(Buffer.from(chunk.subarray(0, chunk.length - (total - opts.maxBytes))));
            truncated = true;
            break;
          }
          chunks.push(Buffer.from(chunk));
        }
        return { url, body: Buffer.concat(chunks), truncated };
      } catch (err) {
        throw asFetchError(err, signal);
      } finally {
        res.close();
      }
    }
  };
}

function asFetchError(err: unknown, signal: AbortSignal): FetchError {
  if (err instanceof FetchError) return err;
  if (signal.aborted) return new FetchError("timeout", "Timed out");
  const code = (err as { code?: string } | null)?.code;
  if (code === "EBLOCKED") return new FetchError("blocked", "Resolves to a non-public address");
  return new FetchError("network", err instanceof Error ? err.message : "Request failed");
}
