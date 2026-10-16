import { stripQuoted } from "../lib/text.ts";

/**
 * Everyday signals: one-time codes, delivery updates, sign-in alerts and urgent mail from people.
 * Plain rules, no model. A wrong chip feels broken, so every rule prefers staying quiet to guessing.
 *
 * A code's value is never part of a Signal. `extractCode` finds it again on demand.
 */

export type SignalKind = "code" | "delivery" | "security" | "urgent";
export type DeliveryStatus = "ordered" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | "delayed" | "customs";

export type Signal =
  | { kind: "code" }
  | { kind: "delivery"; status: DeliveryStatus; tracking?: string; carrier?: string }
  | { kind: "security"; service?: string }
  | { kind: "urgent"; reason: string };

export interface SignalInput {
  subject: string;
  fromEmail: string;
  fromName: string;
  text: string;
  isBulk: boolean;
  sentAt: number;
}

/** Longest stretch of a body the rules read. Codes and shipping notices are short; this bounds the work. */
const MAX_TEXT = 12_000;

const PRIORITY: SignalKind[] = ["urgent", "code", "security", "delivery"];

/** The signal a thread row shows: urgent, then code, then security, then delivery. */
export function topSignal(signals: Signal[]): Signal | null {
  for (const kind of PRIORITY) {
    const hit = signals.find((s) => s.kind === kind);
    if (hit) return hit;
  }
  return null;
}

export function detectSignals(m: SignalInput): Signal[] {
  const text = m.text.slice(0, MAX_TEXT);
  const out: Signal[] = [];
  if (!m.isBulk) {
    const urgent = detectUrgent(m.subject, text);
    if (urgent) out.push(urgent);
  }
  if (locateCode(m.subject, text)) out.push({ kind: "code" });
  const security = detectSecurity(m.subject, text, m.fromName);
  if (security) out.push(security);
  const delivery = detectDelivery(m.subject, text);
  if (delivery) out.push(delivery);
  return out;
}

/** detectSignals for the ingest path: a rule bug must never stall a sync, so it logs and finds nothing. */
export function scanSignals(m: SignalInput): Signal[] {
  try {
    return detectSignals(m);
  } catch (err) {
    console.error("[slipstream] signals:", err);
    return [];
  }
}

// ---- One-time codes ----------------------------------------------------------------

const CODE_KEYWORD = new RegExp(
  [
    "verification code", "verify(?:ing)? code", "one[- ]time (?:code|password|passcode|pin)", "\\bOTP\\b", "security code",
    "(?:sign|log)[- ]?in code", "(?:sign|log)[- ]?in (?:pin|passcode)", "pass ?code", "confirmation code", "your code is", "\\b2FA\\b",
    "two[- ]factor", "two[- ]step", "(?:authentication|authorization|auth|access|login) code", "your (?:one[- ]time )?pin\\b",
    // A few common languages.
    "código de (?:verificaci[oó]n|seguridad|confirmaci[oó]n|acceso|verifica[cç][aã]o|seguran[cç]a)",
    "code de (?:v[ée]rification|confirmation|s[ée]curit[ée]|connexion)", "code d.acc[èe]s", "code [àa] usage unique",
    "Best[äa]tigungscode", "Sicherheitscode", "Verifizierungscode", "Einmalcode", "Anmeldecode",
    "codice di (?:verifica|sicurezza|conferma|accesso)",
  ].join("|"),
  "gi",
);

/** Words that, right before a number, say it's some other kind of number. */
const NOT_A_CODE_LABEL =
  /\b(?:order|invoice|account|acct|reference|ref|tracking|ticket|case|booking|receipt|transaction|policy|member|customer|phone|tel|call|zip|postal|ending|ends|card|amount|total|balance|id|no|num|number|pnr|flight|gate|room|suite|apt|unit|version|build|issue|page|step|ext)\.?\s*(?:number|no\.?|num|#|id|ending in|is|:|=|-)?\s*[:#=-]?\s*$/i;
/** Promo codes look like codes. Anything around them that talks about money off means it isn't a sign-in. */
const PROMO_CONTEXT = /promo|discount|coupon|% off|\bsave\b|\bsale\b|off your|redeem|checkout|voucher|free shipping|offer/i;
const UNIT_TOKEN = /^\d+(?:AM|PM|MB|GB|KB|TB|MS|KG|LB|MM|CM|PX|MHZ|GHZ|USD|EUR|GBP|ST|ND|RD|TH|K|P)$/;
const CODE_TOKEN =
  /\d{3}[ -]\d{3}(?!\d)|\d{4}[ -]\d{4}(?!\d)|\d{4,8}|(?=[A-Z0-9]*\d[A-Z0-9]*\d)[A-Z0-9]{4,8}/g;

interface Located {
  /** The code with separators removed, as someone would paste it. */
  code: string;
}

/** The code in a subject or body, or null. The subject wins when it carries one. */
export function locateCode(subject: string, text: string): Located | null {
  return findCode(subject) ?? findCode(text.slice(0, MAX_TEXT));
}

/** The one-time code itself, or null. Called on demand for a person who asked; values are never stored. */
export function extractCode(subject: string, text: string): string | null {
  return locateCode(subject, text)?.code ?? null;
}

function findCode(s: string): Located | null {
  if (!s) return null;
  CODE_KEYWORD.lastIndex = 0;
  let best: { code: string; distance: number } | null = null;
  for (let k = CODE_KEYWORD.exec(s); k; k = CODE_KEYWORD.exec(s)) {
    const kStart = k.index;
    const kEnd = k.index + k[0].length;
    const from = Math.max(0, kStart - 80);
    const to = Math.min(s.length, kEnd + 80);
    CODE_TOKEN.lastIndex = from;
    for (let t = CODE_TOKEN.exec(s); t && t.index < to; t = CODE_TOKEN.exec(s)) {
      const start = t.index;
      const end = start + t[0].length;
      if (start < from || end > to) continue;
      // The keyword's own text can't be the code (the "2FA" keyword has digits).
      if (start < kEnd && end > kStart) continue;
      const after = start >= kEnd;
      const gap = after ? s.slice(kEnd, start) : s.slice(end, kStart);
      const direct = after ? /^[\s:=\-–—]*(?:is|are|was)?[\s:=\-–—]*$/i.test(gap) : /^\s*(?:is|was)?\s*(?:your|the|my)?\s*$/i.test(gap);
      if (!plausible(s, start, end, direct)) continue;
      const distance = after ? gap.length : gap.length + 5; // reading order: the code usually follows its name
      if (!best || distance < best.distance) best = { code: t[0].replace(/[ -]/g, ""), distance };
    }
  }
  return best ? { code: best.code } : null;
}

function plausible(s: string, start: number, end: number, direct: boolean): boolean {
  const token = s.slice(start, end);
  const prev = s[start - 1] ?? "";
  const prev2 = s[start - 2] ?? "";
  const next = s[end] ?? "";
  const next2 = s[end + 1] ?? "";
  const alnum = /[A-Za-z0-9]/;
  // Part of something longer.
  if (alnum.test(prev) || alnum.test(next)) return false;
  // Prices, hashtags, paths, addresses, phone numbers, versions, dates and times.
  if (/[#$€£¥,/+@_%]/.test(prev)) return false;
  if ((prev === "." || prev === "-") && alnum.test(prev2)) return false;
  if (prev === ":" && /\d/.test(prev2)) return false;
  if (/[ -]/.test(prev) && /\d/.test(prev2)) return false;
  if (/[,.:\-/ ]/.test(next) && /\d/.test(next2)) return false;
  if (/[%@_]/.test(next)) return false;
  if (/^\s?(?:am|pm|a\.m|p\.m|st|nd|rd|th|usd|eur|gbp|dollars|euros)\b/i.test(s.slice(end, end + 10))) return false;
  if (UNIT_TOKEN.test(token)) return false;
  if (/^(\d)\1+$/.test(token)) return false;
  if (/[A-Z]/.test(token) && token.replace(/\D/g, "").length < 2) return false;
  if (PROMO_CONTEXT.test(s.slice(Math.max(0, start - 150), end + 150))) return false;
  if (direct) return true;
  if (NOT_A_CODE_LABEL.test(s.slice(Math.max(0, start - 30), start))) return false;
  // Years are the commonest stray 4-digit number near a keyword (a copyright line, a date).
  if (/^(?:19|20)\d{2}$/.test(token)) return false;
  // Long plain digit runs are phone numbers and ids unless the keyword points right at them.
  if (/^\d{7,8}$/.test(token)) return false;
  return true;
}

/** Replace a code in text with a mask, including the "482 913" and "482-913" forms. */
export function hideCode(s: string, code: string): string {
  if (!s || !code) return s;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const half = /^\d+$/.test(code) && (code.length === 6 || code.length === 8) ? code.length / 2 : 0;
  const body = half ? `${esc(code.slice(0, half))}(?:[ \\u00a0-]|&nbsp;)?${esc(code.slice(half))}` : esc(code);
  return s.replace(new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "g"), "••••••");
}

/**
 * Mask a one-time code wherever a message carries it, for readers that must never see one
 * (agents, team snapshots). The person's own view keeps the real text.
 */
export function maskCodes<T extends { subject: string; snippet?: string; text?: string; html?: string | null }>(m: T): T {
  const code = extractCode(m.subject, m.text || m.snippet || "");
  if (!code) return m;
  const out = { ...m, subject: hideCode(m.subject, code) };
  if (m.snippet !== undefined) out.snippet = hideCode(m.snippet, code);
  if (m.text !== undefined) out.text = hideCode(m.text, code);
  if (m.html) out.html = hideCode(m.html, code);
  return out;
}

// ---- Deliveries --------------------------------------------------------------------

const PACKAGE_WORD = /\b(?:order|package|parcel|shipment|delivery|deliveries|item|items|tracking|courier|carrier)\b/i;

/** Text just before a match that makes it a promise, not news: "once your order has shipped". */
const NOT_YET = /\b(?:when|once|after|until|if|before|soon as)\s+(?:[\w']+\s+){0,3}$/i;

/** Checked in order; the first that matches wins. Past-tense forms only, so "we'll tell you when it's delivered" stays quiet. */
const STATUS_RULES: { status: DeliveryStatus; strong: boolean; re: RegExp }[] = [
  { status: "out_for_delivery", strong: true, re: /\bout for delivery\b/i },
  { status: "delivered", strong: false, re: /\b(?:has|have|was|were)\s+(?:been\s+)?delivered\b|\bdelivered\s+(?:to|at|on|today)\b|\bdelivery (?:complete|confirmed)\b|^\s*delivered\b/i },
  { status: "customs", strong: true, re: /\bheld (?:at|by|in) customs\b|\bcustoms (?:clearance|hold|delay)\b|\bcleared customs\b/i },
  { status: "delayed", strong: false, re: /\b(?:delayed|delay in (?:delivery|shipping)|running late)\b/i },
  { status: "in_transit", strong: false, re: /\bin transit\b|\barriving\s+(?:today|tomorrow|soon|on|by|between|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bexpected (?:delivery|arrival)\b|\bestimated delivery\b/i },
  {
    status: "shipped",
    strong: false,
    re: /\b(?:has|have|had|was|were|just|been|order)\s+(?:been\s+)?shipped\b|\bon (?:its|the) way\b|\bshipping confirmation\b|\bshipment (?:is )?(?:confirmed|created)\b|^\s*shipped\b/i,
  },
];

const TRACKING_LABEL = /tracking\s*(?:number|no\.?|num|id|code|#)\s*(?:is|:|#)?\s*:?\s*([A-Z0-9][A-Z0-9-]{6,34})\b/gi;
const WELL_KNOWN_TRACKING = /\b(1Z[0-9A-Z]{16}|9[2-5]\d{20,24}|[A-Z]{2}\d{9}[A-Z]{2})\b/;

const KNOWN_CARRIERS = [
  "UPS", "FedEx", "DHL", "USPS", "Royal Mail", "Canada Post", "Australia Post", "Evri", "DPD", "GLS", "Yamato", "LaserShip", "OnTrac",
  "Amazon Logistics", "Purolator", "PostNL", "Correos", "La Poste", "Deutsche Post", "Japan Post", "Sendle", "Aramex", "Parcelforce", "An Post",
];
const NAMED_CARRIER = /(?:\b[Cc]arrier|\b[Cc]ourier|\b[Ss]hipped (?:via|with|by)|\b[Dd]elivered (?:via|by|with)|\b[Dd]elivery partner|\b[Ss]hipping partner)\s*(?:is|:|-)?\s+([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,3})/;
const CARRIER_STOP = new Set(["Tracking", "Track", "Estimated", "Expected", "Delivery", "Order", "Shipping", "Status", "Service", "Number", "Your", "The", "Ship", "Date"]);

function detectDelivery(rawSubject: string, text: string): Signal | null {
  // A reply to a shipping notice isn't one.
  const subject = /^\s*(?:re|fwd?|aw|wg)\s*:/i.test(rawSubject) ? "" : rawSubject;
  const head = `${subject}\n${text.slice(0, 4000)}`;
  const hasWord = PACKAGE_WORD.test(head);
  const trackingMatch = matchTracking(head);

  const statusIn = (s: string) => {
    for (const r of STATUS_RULES) {
      const hit = r.re.exec(s);
      if (!hit || NOT_YET.test(s.slice(Math.max(0, hit.index - 40), hit.index))) continue;
      if (r.strong || hasWord) return r.status;
    }
    return null;
  };
  // A tracking number on its own already says a package exists; with no status word it's shipped news.
  const status = statusIn(subject) ?? statusIn(text.slice(0, 4000)) ?? (trackingMatch && /tracking\s*(?:number|no|id|#)/i.test(head) ? "shipped" : null);
  if (!status) return null;

  const signal: Extract<Signal, { kind: "delivery" }> = { kind: "delivery", status };
  if (trackingMatch) signal.tracking = trackingMatch;
  const carrier = matchCarrier(head);
  if (carrier) signal.carrier = carrier;
  return signal;
}

function matchTracking(s: string): string | null {
  TRACKING_LABEL.lastIndex = 0;
  for (let m = TRACKING_LABEL.exec(s); m; m = TRACKING_LABEL.exec(s)) {
    const value = m[1]!;
    const digits = value.replace(/\D/g, "").length;
    // A real tracking id is long and mostly digits; "SM-4471" is an order number.
    if (value.replace(/-/g, "").length >= 8 && digits >= 5) return value.toUpperCase();
  }
  return WELL_KNOWN_TRACKING.exec(s)?.[1] ?? null;
}

function matchCarrier(s: string): string | null {
  for (const name of KNOWN_CARRIERS) {
    if (new RegExp(`(?<![A-Za-z])${name.replace(/ /g, "\\s+")}(?![A-Za-z])`).test(s)) return name;
  }
  const named = NAMED_CARRIER.exec(s)?.[1];
  if (!named) return null;
  const words: string[] = [];
  for (const w of named.replace(/[.,;:]+$/, "").split(/\s+/)) {
    if (CARRIER_STOP.has(w)) break;
    words.push(w.replace(/[.,;:]+$/, ""));
  }
  const name = words.join(" ").trim();
  return name.length >= 2 && name.length <= 40 ? name : null;
}

// ---- Security alerts ---------------------------------------------------------------

const SECURITY_PHRASES = [
  /\bnew (?:sign|log)[- ]?in\b/i,
  /\b(?:sign|log)(?:ged|ed)?[- ]?in (?:attempt|alert|notification|from a (?:new|different|unrecognized))/i,
  /\b(?:signed|logged) in from\b/i,
  /\b(?:signed|logged) in (?:on|to) (?:a |an )(?:new|different|unrecogni[sz]ed|unknown)\b/i,
  /\bunusual (?:sign|log)[- ]?in\b/i,
  /\bsuspicious (?:sign|log)[- ]?in\b/i,
  /\bwas your account accessed\b/i,
  /\bsomeone (?:just |recently )?(?:signed|logged) in\b/i,
  /\bwe noticed a (?:new|recent|unusual) (?:sign|log)[- ]?in\b/i,
];
const SERVICE_SUFFIX = /\s+(?:alerts?|security|team|support|notifications?|no-?reply|accounts?|noreply|mailer)$/i;

function detectSecurity(subject: string, text: string, fromName: string): Signal | null {
  const head = `${subject}\n${text.slice(0, 800)}`;
  const phrase = SECURITY_PHRASES.some((re) => re.test(head));
  // "New device" alone is too common in shop mail; it counts next to sign-in or account words.
  const device = /\bnew (?:device|browser)\b/i.test(head) && /\b(?:sign|log)[- ]?(?:ed )?in\b|\baccount\b|\baccess/i.test(head);
  if (!phrase && !device) return null;
  const name = fromName.replace(SERVICE_SUFFIX, "").trim();
  return name && !name.includes("@") && name.length <= 60 ? { kind: "security", service: name } : { kind: "security" };
}

// ---- Urgent mail from people -------------------------------------------------------

const MONEY_WORD = /\b(?:invoice|payment|bill|balance|rent|amount|fee|fees|loan|premium|tuition|tax|taxes|statement|mortgage|dues)\b/i;
const LEGAL_RE = /\b(?:court (?:date|hearing|appearance|order)|summons|subpoena|lawsuit|legal action|cease[- ]and[- ]desist|notice of default|garnishment|eviction|notice to vacate|notice to quit)\b/i;
const OVERDUE_RE = /\b(?:past due|overdue|collections?|collection agency|chargeback|final notice)\b/i;
const DEADLINE_RE = /\bdeadline\b[^.\n]{0,40}\b(?:today|tomorrow|tonight)\b|\b(?:today|tomorrow|tonight)\b[^.\n]{0,40}\bdeadline\b|\bdeadline (?:is|falls) (?:on )?(?:today|tomorrow)\b/i;

function detectUrgent(subject: string, text: string): Signal | null {
  const body = stripQuoted(text).slice(0, 600);
  for (const s of [subject, body]) {
    if (LEGAL_RE.test(s)) return { kind: "urgent", reason: "Legal notice" };
  }
  for (const s of [subject, body]) {
    const m = OVERDUE_RE.exec(s);
    if (!m) continue;
    // "Final notice" stands alone; "overdue" and "past due" need money in the picture (an overdue library book isn't urgent).
    if (/final notice/i.test(m[0])) return { kind: "urgent", reason: MONEY_WORD.test(`${subject} ${body}`) ? "Overdue payment" : "Final notice" };
    if (/chargeback/i.test(m[0])) return { kind: "urgent", reason: "Payment dispute" };
    if (MONEY_WORD.test(`${subject} ${body}`)) return { kind: "urgent", reason: "Overdue payment" };
  }
  for (const s of [subject, body]) {
    if (DEADLINE_RE.test(s)) return { kind: "urgent", reason: "Deadline" };
  }
  return null;
}
