import dns from "node:dns";
import { domainToASCII } from "node:url";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { FetchError, httpsTransport, isPublicHostname, makeSafeFetch, type SafeFetch } from "./safe-fetch.ts";
import { sanitizeSvg } from "./svg.ts";
import type { MailStore } from "./store.ts";

// --- Which domain a sender's logo belongs to ---------------------------------------------------

/** Two-label public suffixes where the registrable domain has three labels (brand.co.uk). */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "gov.in",
  "co.za", "org.za", "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.sg", "com.tw", "com.mx", "com.ar",
  "com.tr", "com.ua", "co.kr", "or.kr", "co.il", "co.id", "co.th", "com.my", "com.ph", "com.vn", "com.co",
  "com.pe", "com.eg", "com.sa", "co.ke",
]);

/** Providers that give people personal mailboxes; a logo there says nothing about the sender. */
const PERSONAL_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "protonmail.ch", "pm.me", "mail.com", "fastmail.com", "fastmail.fm", "hey.com", "zoho.com", "zohomail.com", "qq.com",
  "163.com", "126.com", "sina.com", "tutanota.com", "tutanota.de", "tuta.io", "tutamail.com", "mail.ru", "inbox.ru",
  "list.ru", "bk.ru", "rambler.ru", "web.de", "t-online.de", "orange.fr", "free.fr", "laposte.net", "btinternet.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "bellsouth.net", "charter.net", "rediffmail.com",
  "naver.com", "daum.net", "hanmail.net", "libero.it", "seznam.cz", "wp.pl", "o2.pl", "onet.pl", "example.com",
  "example.net", "example.org",
]);
/** Personal-mail brands that exist under many country endings (hotmail.fr, yahoo.co.uk, gmx.de ...). */
const PERSONAL_BRANDS = new Set(["hotmail", "yahoo", "gmx", "yandex", "outlook", "live", "ymail", "rocketmail"]);

/**
 * The registrable domain a sender's logo is looked up under (mail.brand.co.uk -> brand.co.uk), or null when
 * there is nothing sensible to fetch: personal providers, IP literals, single-label or private-use hosts.
 */
export function logoDomain(email: string): string | null {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const host = domainToASCII(address.slice(at + 1));
  if (!host || !isPublicHostname(host)) return null;
  const labels = host.split(".");
  const take = MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  if (labels.length < take) return null;
  const registrable = labels.slice(-take).join(".");
  if (PERSONAL_PROVIDERS.has(registrable) || PERSONAL_BRANDS.has(labels[labels.length - take]!)) return null;
  return registrable;
}

// --- Telling real images from anything else ----------------------------------------------------

export interface LogoImage {
  contentType: string;
  bytes: Buffer;
}

/** Identifies an image by its first bytes, ignoring whatever the server called it. SVG is sanitized on the way through. */
export function sniffImage(bytes: Buffer): LogoImage | null {
  if (bytes.length < 16) return null;
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { contentType: "image/png", bytes };
  if (starts(0xff, 0xd8, 0xff)) return { contentType: "image/jpeg", bytes };
  if (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a") return { contentType: "image/gif", bytes };
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return { contentType: "image/webp", bytes };
  if (starts(0, 0, 1, 0)) {
    const count = bytes.readUInt16LE(4);
    return count >= 1 && bytes.length >= 6 + 16 * count ? { contentType: "image/x-icon", bytes } : null;
  }
  const head = bytes.subarray(0, 2048);
  if (head.includes(0)) return null;
  const svg = sanitizeSvg(bytes.toString("utf8"));
  return svg ? { contentType: "image/svg+xml", bytes: Buffer.from(svg) } : null;
}

// --- Finding a page's icon ---------------------------------------------------------------------

interface IconLink {
  url: URL;
  score: number;
}

/** `<link rel="icon">` and apple-touch-icon candidates from a page, best first: apple-touch-icon, then the largest declared size. */
export function findIconLinks(html: string, base: URL): IconLink[] {
  const found = new Map<string, IconLink>();
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    }
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    const apple = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!apple && !rel.includes("icon")) continue;
    if (!attrs.href) continue;
    let url: URL;
    try {
      url = new URL(attrs.href.replace(/&amp;/gi, "&"), base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    let area = 0;
    for (const m of (attrs.sizes ?? "").toLowerCase().matchAll(/(\d+)x(\d+)/g)) area = Math.max(area, Number(m[1]) * Number(m[2]));
    if (/\bany\b/i.test(attrs.sizes ?? "")) area = Math.max(area, 512 * 512);
    const score = (apple ? 1_000_000_000 : 0) + area;
    const key = url.href;
    if (!found.has(key) || found.get(key)!.score < score) found.set(key, { url, score });
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}

/** The logo address inside a BIMI TXT record, if it names an https one. */
export function bimiLocation(records: string[][]): string | null {
  for (const chunks of records) {
    const record = chunks.join("");
    if (!/^\s*v=BIMI1\s*;/i.test(record)) continue;
    for (const field of record.split(";")) {
      const eq = field.indexOf("=");
      if (eq > 0 && field.slice(0, eq).trim().toLowerCase() === "l") {
        const value = field.slice(eq + 1).trim();
        return /^https:\/\//i.test(value) ? value : null;
      }
    }
  }
  return null;
}

// --- The service -------------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FOUND_TTL = 30 * DAY;
const NONE_TTL = 7 * DAY;
/** A miss that never got an answer (offline, DNS down) is tried again soon rather than after a week. */
const TRANSIENT_RETRY = HOUR;
const DOMAIN_BUDGET_MS = 8_000;
const MAX_CONCURRENT = 4;
const MAX_PENDING = 1_000;
const HTML_CAP = 256 * 1024;
const IMAGE_CAP = 200 * 1024;

export interface LogoDeps {
  safeFetch?: SafeFetch;
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** Milliseconds to wait before fetching a domain nobody has fetched yet. Defaults to a random 1 to 6 hours. */
  delayMs?: () => number;
  /** Runs `fn` later and returns a canceller. Defaults to an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
}

interface Row {
  status: "found" | "none";
  content_type: string | null;
  blob_sha256: string | null;
  fetched_at: number;
}

type Discovery = { image: LogoImage; source: string } | { image: null; reached: boolean };

export class SenderLogos {
  private pending = new Map<string, () => void>();
  private inFlight = new Map<string, Promise<void>>();
  private queue: (() => void)[] = [];
  private running = 0;
  private readonly safeFetch: SafeFetch;
  private readonly resolveTxt: (name: string) => Promise<string[][]>;
  private readonly delayMs: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;
  private readonly ctx: { db: Db; store: MailStore; config: Config };

  constructor(ctx: { db: Db; store: MailStore; config: Config }, deps: LogoDeps = {}) {
    this.ctx = ctx;
    this.safeFetch = deps.safeFetch ?? makeSafeFetch(httpsTransport());
    this.resolveTxt = deps.resolveTxt ?? ((name) => dns.promises.resolveTxt(name));
    this.delayMs = deps.delayMs ?? (() => HOUR + Math.random() * 5 * HOUR);
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.now = deps.now ?? Date.now;
  }

  /** Cancels fetches that were waiting for their random delay; the next request for the domain schedules it again. */
  close(): void {
    for (const cancel of this.pending.values()) cancel();
    this.pending.clear();
  }

  /** The user's own switch: true only when they turned logos on. */
  userSetting(userId: string): boolean | undefined {
    const row = this.ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = 'senderLogos'", userId);
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value);
      return typeof value === "boolean" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Server and user both agree to network fetches. Unset means off. */
  fetchingAllowed(userId: string): boolean {
    return this.ctx.config.senderLogos && this.userSetting(userId) === true;
  }

  /**
   * What is cached for a domain, never touching the network. A domain with nothing usable cached (or
   * with a stale entry) is queued for a fetch at a random time hours from now, so the fetch can't be lined
   * up with the arrival of a message. The caller gets 404-equivalent `null` until then.
   */
  cached(domain: string, userId: string): LogoImage | null {
    const row = this.ctx.db.get<Row>("SELECT status, content_type, blob_sha256, fetched_at FROM sender_logos WHERE domain = ?", domain);
    const age = row ? this.now() - row.fetched_at : Infinity;
    const image = row?.status === "found" && row.blob_sha256 && row.content_type ? this.readImage(row) : null;
    const fresh = row ? (row.status === "found" ? image !== null && age < FOUND_TTL : age < NONE_TTL) : false;
    if (!fresh) this.queueFetch(domain, userId);
    return image;
  }

  private readImage(row: Row): LogoImage | null {
    const bytes = this.ctx.store.readBlob(row.blob_sha256!);
    return bytes ? { contentType: row.content_type!, bytes } : null;
  }

  private queueFetch(domain: string, userId: string): void {
    if (this.pending.has(domain) || this.inFlight.has(domain) || this.pending.size >= MAX_PENDING) return;
    const cancel = this.schedule(() => {
      this.pending.delete(domain);
      // Re-check at the moment of the fetch: the person may have switched logos off in the meantime.
      if (this.fetchingAllowed(userId)) void this.fetchNow(domain);
    }, this.delayMs());
    this.pending.set(domain, cancel);
  }

  /** Fetches and stores one domain now. Concurrent calls for the same domain share one fetch; at most four run at once. */
  fetchNow(domain: string): Promise<void> {
    let job = this.inFlight.get(domain);
    if (!job) {
      job = this.limited(() => this.refresh(domain)).finally(() => this.inFlight.delete(domain));
      this.inFlight.set(domain, job);
    }
    return job;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing job hands its slot straight to the next waiter, so the count never exceeds the cap.
    if (this.running >= MAX_CONCURRENT) await new Promise<void>((go) => this.queue.push(go));
    else this.running += 1;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  private async refresh(domain: string): Promise<void> {
    const db = this.ctx.db;
    let result: Discovery;
    try {
      result = await this.discover(domain, AbortSignal.timeout(DOMAIN_BUDGET_MS));
    } catch (err) {
      console.error("[slipstream] sender logo:", err);
      result = { image: null, reached: false };
    }
    const now = this.now();
    if (result.image) {
      const sha = this.ctx.store.saveBlob(result.image.bytes);
      db.run(
        `INSERT INTO sender_logos (domain, status, content_type, blob_sha256, source, fetched_at) VALUES (?, 'found', ?, ?, ?, ?)
         ON CONFLICT (domain) DO UPDATE SET status = 'found', content_type = excluded.content_type, blob_sha256 = excluded.blob_sha256, source = excluded.source, fetched_at = excluded.fetched_at`,
        domain,
        result.image.contentType,
        sha,
        result.source,
        now,
      );
      return;
    }
    // Nothing reachable at all: try again in an hour. Otherwise it is a real "no logo": a week, or a month if we already had one.
    const previous = db.get<{ status: string }>("SELECT status FROM sender_logos WHERE domain = ?", domain);
    const retryIn = result.reached ? NONE_TTL : TRANSIENT_RETRY;
    if (previous?.status === "found") {
      // Keep the logo we have; only move its next refresh.
      db.run("UPDATE sender_logos SET fetched_at = ? WHERE domain = ?", now - FOUND_TTL + retryIn, domain);
    } else {
      db.run(
        `INSERT INTO sender_logos (domain, status, fetched_at) VALUES (?, 'none', ?)
         ON CONFLICT (domain) DO UPDATE SET status = 'none', content_type = NULL, blob_sha256 = NULL, source = NULL, fetched_at = excluded.fetched_at`,
        domain,
        now - NONE_TTL + retryIn,
      );
    }
  }

  private async discover(domain: string, deadline: AbortSignal): Promise<Discovery> {
    let reached = false;
    const attempt = async (url: string, opts: { cap: number; accept: string; truncate?: boolean; scoped?: boolean }) => {
      try {
        return await this.safeFetch(url, {
          signal: deadline,
          maxBytes: opts.cap,
          accept: opts.accept,
          truncate: opts.truncate,
          allowHost: opts.scoped ? (h) => h === domain || h.endsWith(`.${domain}`) : undefined,
        });
      } catch (err) {
        if (err instanceof FetchError && err.reached) reached = true;
        return null;
      }
    };
    const image = async (url: string | URL, scoped = false) => {
      const res = await attempt(String(url), { cap: IMAGE_CAP, accept: "image/*", scoped });
      if (!res) return null;
      reached = true;
      return sniffImage(res.body);
    };

    // (a) BIMI: the sender's own published SVG.
    try {
      const location = bimiLocation(await this.resolveTxt(`default._bimi.${domain}`));
      reached = true;
      if (location) {
        const svg = await image(location);
        if (svg?.contentType === "image/svg+xml") return { image: svg, source: "bimi" };
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "ENODATA" || code === "ENOTFOUND") reached = true;
    }

    // (b) The homepage's declared icons.
    let pageHost = domain;
    for (const host of [domain, `www.${domain}`]) {
      const page = await attempt(`https://${host}/`, { cap: HTML_CAP, accept: "text/html", truncate: true, scoped: true });
      if (!page) continue;
      reached = true;
      pageHost = page.url.hostname;
      for (const link of findIconLinks(page.body.toString("utf8"), page.url).slice(0, 3)) {
        const found = await image(link.url);
        if (found) return { image: found, source: "icon" };
      }
      break;
    }

    // (c) /favicon.ico
    const favicon = await image(`https://${pageHost}/favicon.ico`);
    if (favicon) return { image: favicon, source: "favicon" };
    return { image: null, reached };
  }
}

// --- Who may ask for what ----------------------------------------------------------------------

/**
 * Whether this person has received mail from the domain (or one of its subdomains), and whether every such
 * message sits in a demo account. Keeps the logo route from being a fetch-anything oracle.
 */
export function mailFromDomain(db: Db, userId: string, domain: string): { any: boolean; allDemo: boolean } {
  // `domain` is a validated host name (letters, digits, dots, hyphens), so it needs no LIKE escaping.
  const query = (demo: boolean) =>
    db
      .all<{ from_email: string }>(
        `SELECT DISTINCT m.from_email FROM messages m JOIN accounts a ON a.id = m.account_id
         WHERE a.user_id = ? AND a.provider ${demo ? "=" : "!="} 'demo' AND (m.from_email LIKE ? OR m.from_email LIKE ?) LIMIT 200`,
        userId,
        `%@${domain}`,
        `%@%.${domain}`,
      )
      .some((r) => logoDomain(r.from_email) === domain);
  if (query(false)) return { any: true, allDemo: false };
  return query(true) ? { any: true, allDemo: true } : { any: false, allDemo: false };
}
