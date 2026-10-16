import { Resolver } from "node:dns/promises";
import type { Config } from "../config.ts";
import type { Discovery, MailHost, ServerSettings } from "../../../web/src/types.ts";
import { IMAP_PRESETS } from "./imap.ts";

/**
 * Works out where an address's mail lives, for the "add an account" screen. It only reads the address's own
 * domain: a built-in list of well-known domains first, then that domain's MX and RFC 6186 SRV records over DNS.
 * No third-party lookup service is ever asked.
 */

export interface MxRecord {
  exchange: string;
  priority: number;
}
export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}
/** The two DNS lookups discovery needs. Tests pass a stub; the real one is node's resolver. */
export interface DnsLookup {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolveSrv(name: string): Promise<SrvRecord[]>;
}
export interface DiscoverDeps {
  dns?: DnsLookup;
  /** Longest wait for any one lookup, in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

// Brands that run one domain per country (hotmail.co.uk, yahoo.com.au, live.fr).
const TLD = String.raw`(?:com|[a-z]{2}|(?:co|com|ne|or)\.[a-z]{2})`;

// Fastmail's own country domains; the long tail of vanity domains is caught by its MX records instead.
const FASTMAIL_DOMAINS = new Set([
  "fastmail.com", "fastmail.fm", "fastmail.cn", "fastmail.co.uk", "fastmail.com.au", "fastmail.de", "fastmail.es",
  "fastmail.fr", "fastmail.im", "fastmail.in", "fastmail.jp", "fastmail.mx", "fastmail.net", "fastmail.nl",
  "fastmail.org", "fastmail.se", "fastmail.to", "fastmail.tw", "fastmail.uk", "fastmail.us", "sent.com",
]);

/** Domains whose provider is known without asking DNS. */
const KNOWN: { host: MailHost; test: (domain: string) => boolean }[] = [
  { host: "gmail", test: (d) => d === "gmail.com" || d === "googlemail.com" },
  { host: "outlook", test: (d) => d === "msn.com" || new RegExp(`^(?:outlook|hotmail|live)\\.${TLD}$`).test(d) },
  { host: "icloud", test: (d) => d === "icloud.com" || d === "me.com" || d === "mac.com" },
  // Yahoo Japan is a separate service with its own servers.
  { host: "yahoo", test: (d) => d === "ymail.com" || d === "rocketmail.com" || (d !== "yahoo.co.jp" && new RegExp(`^yahoo\\.${TLD}$`).test(d)) },
  { host: "fastmail", test: (d) => FASTMAIL_DOMAINS.has(d) },
  { host: "zoho", test: (d) => d === "zoho.com" || d === "zohomail.com" },
  { host: "proton", test: (d) => d === "proton.me" || d === "protonmail.com" || d === "protonmail.ch" || d === "pm.me" },
];

const endsWithDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** What a mail exchanger's name says about who hosts the domain's mail. */
const MX_HOSTS: { host: MailHost; test: (mx: string) => boolean }[] = [
  { host: "gmail", test: (mx) => endsWithDomain(mx, "google.com") || endsWithDomain(mx, "googlemail.com") },
  { host: "outlook", test: (mx) => endsWithDomain(mx, "outlook.com") },
  { host: "icloud", test: (mx) => endsWithDomain(mx, "icloud.com") },
  { host: "fastmail", test: (mx) => endsWithDomain(mx, "messagingengine.com") },
  { host: "zoho", test: (mx) => /(?:^|\.)zoho(?:mail)?\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(mx) },
  { host: "yahoo", test: (mx) => endsWithDomain(mx, "yahoodns.net") },
  { host: "proton", test: (mx) => endsWithDomain(mx, "protonmail.ch") },
];

/** The domain part of an address, lowercased; null if there isn't one. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).trim().toLowerCase() : null;
}

/** Rejects after `ms`, so a resolver that never answers can't hold a request open. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** One lookup. Any failure (no such record, no such domain, timeout, refused) just means "no records". */
async function lookup<T>(run: () => Promise<T[]>, ms: number): Promise<T[]> {
  try {
    return await within(run(), ms);
  } catch {
    return [];
  }
}

const bare = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");

/** Lowest priority first, then heaviest weight. A "." target means the service isn't offered here (RFC 6186). */
function bestSrv(records: SrvRecord[]): SrvRecord | null {
  const usable = records.filter((r) => bare(r.name) !== "" && r.port > 0);
  usable.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  return usable[0] ?? null;
}

async function srvServers(domain: string, dns: DnsLookup, ms: number): Promise<ServerSettings | null> {
  const [imaps, imap, submissions, submission] = await Promise.all([
    lookup(() => dns.resolveSrv(`_imaps._tcp.${domain}`), ms),
    lookup(() => dns.resolveSrv(`_imap._tcp.${domain}`), ms),
    lookup(() => dns.resolveSrv(`_submissions._tcp.${domain}`), ms),
    lookup(() => dns.resolveSrv(`_submission._tcp.${domain}`), ms),
  ]);
  // The TLS-from-the-start records win; the plain ones mean STARTTLS on that port.
  const imapTls = bestSrv(imaps);
  const smtpTls = bestSrv(submissions);
  const inbound = imapTls ?? bestSrv(imap);
  const outbound = smtpTls ?? bestSrv(submission);
  if (!inbound || !outbound) return null;
  return {
    imapHost: bare(inbound.name),
    imapPort: inbound.port,
    imapSecure: imapTls !== null,
    smtpHost: bare(outbound.name),
    smtpPort: outbound.port,
    smtpSecure: smtpTls !== null,
  };
}

/** `email` must already be a syntactically valid address. */
export async function discover(email: string, config: Config, deps: DiscoverDeps = {}): Promise<Discovery> {
  const domain = domainOf(email) ?? "";
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = (provider: MailHost, source: Discovery["source"], preset: string | null, servers: ServerSettings | null = null): Discovery => ({
    email,
    domain,
    provider,
    preset: preset && preset in IMAP_PRESETS ? preset : null,
    oauth: provider === "gmail" && config.google.clientId ? "google" : provider === "outlook" && config.microsoft.clientId ? "microsoft" : null,
    servers,
    source,
  });

  const known = KNOWN.find((k) => k.test(domain));
  if (known) return result(known.host, "preset", known.host);

  const dns = deps.dns ?? new Resolver({ timeout: timeoutMs, tries: 1 });
  const mx = (await lookup(() => dns.resolveMx(domain), timeoutMs))
    .map((r) => ({ exchange: bare(r.exchange), priority: r.priority }))
    .sort((a, b) => a.priority - b.priority);
  for (const { exchange } of mx) {
    const hit = MX_HOSTS.find((h) => h.test(exchange));
    if (!hit) continue;
    // Zoho runs separate regions with their own servers; the built-in settings are for zoho.com only.
    return result(hit.host, "mx", hit.host === "zoho" && !exchange.endsWith(".zoho.com") ? null : hit.host);
  }

  const servers = await srvServers(domain, dns, timeoutMs);
  return servers ? result("imap", "srv", null, servers) : result("imap", "none", null);
}
