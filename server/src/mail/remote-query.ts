import type { SearchObject } from "imapflow";
import { hasTextTerm, parse, parseDate, parseRelative, type Clause, type Term } from "./query.ts";
import type { ProviderQuery, SearchTerm } from "./types.ts";

/**
 * Searching at the provider: Slipstream's search language is cut into what a provider can run (free words, from:, to:,
 * subject:, has:attachment, after:/before:, newer:/older:) and what only exists on this machine (is:, label:, category:, in:,
 * cc:, filename:, other has: values). A clause with any term of the second kind stays whole on this machine, since "a OR b"
 * can't be sent without b. The local part still narrows whatever the provider returns.
 */
export interface RemotePlan {
  /** What to send, or null when nothing in the search can be sent. */
  query: ProviderQuery | null;
  /** Clauses that stay on this machine. */
  local: Clause[];
  /** The operators left out of what the provider is asked, as typed ("is:code", "-label:work"). */
  localOnly: string[];
  /** `account:` terms: the lower-case addresses to search, or empty for every account. */
  accounts: string[];
  /** Whether the search matches message text, which is what the agent guard cares about. */
  hasText: boolean;
}

function toSearchTerm(t: Term, now: number): SearchTerm | null {
  const { neg, value } = t;
  switch (t.key) {
    case null:
      return { kind: "text", value, neg };
    case "from":
    case "to":
    case "subject":
      return { kind: t.key, value, neg };
    case "has":
      return /^attachments?$/i.test(value) ? { kind: "attachment", neg } : null;
    case "after":
    case "before": {
      const at = parseDate(value) ?? parseRelative(value, now);
      return at === null ? null : { kind: t.key, at, neg };
    }
    case "newer":
    case "older": {
      const at = parseRelative(value, now);
      return at === null ? null : { kind: t.key === "newer" ? "after" : "before", at, neg };
    }
    default:
      return null;
  }
}

const asTyped = (t: Term) => `${t.neg ? "-" : ""}${t.key}:${/\s/.test(t.value) ? `"${t.value}"` : t.value}`;

export function planRemote(input: string, now = Date.now()): RemotePlan {
  const clauses = parse(input);
  const sent: SearchTerm[][] = [];
  const local: Clause[] = [];
  const accounts: string[] = [];
  const localOnly = new Set<string>();
  for (const clause of clauses) {
    if (clause.every((t) => t.key === "account" && !t.neg)) {
      accounts.push(...clause.map((t) => t.value.toLowerCase()));
      continue;
    }
    const terms = clause.map((t) => toSearchTerm(t, now));
    if (terms.every((t): t is SearchTerm => t !== null)) {
      sent.push(terms);
      continue;
    }
    local.push(clause);
    for (const t of clause) if (t.key !== null && !toSearchTerm(t, now)) localOnly.add(asTyped(t));
  }
  return {
    query: sent.length ? { clauses: sent } : null,
    local,
    localOnly: [...localOnly],
    accounts,
    hasText: hasTextTerm(clauses),
  };
}

/* ---------------------------------------------------------------- Gmail */

/** Quotes and backslashes can't be escaped the same way in every dialect, so they are dropped from what is sent. */
const plain = (v: string) => v.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
const WORD = /^[\p{L}\p{N}_.@+'-]+$/u;

/** The same string works for the Gmail API's `q` and for IMAP's X-GM-RAW. */
export function gmailQuery(q: ProviderQuery): string {
  const value = (v: string) => {
    const p = plain(v);
    return WORD.test(p) && !p.startsWith("-") && !/^(OR|AND|AROUND)$/.test(p) ? p : `"${p}"`;
  };
  const term = (t: SearchTerm): string => {
    let s: string;
    switch (t.kind) {
      case "text":
        s = value(t.value);
        break;
      case "attachment":
        s = "has:attachment";
        break;
      case "after":
      case "before":
        // Epoch seconds: Gmail has no hours or weeks, and its "m" is a month where Slipstream's is 30 days.
        s = `${t.kind}:${Math.floor(t.at / 1000)}`;
        break;
      default:
        s = `${t.kind}:${value(t.value)}`;
    }
    return t.neg ? `-${s}` : s;
  };
  return q.clauses.map((c) => (c.length === 1 ? term(c[0]!) : `(${c.map(term).join(" OR ")})`)).join(" ");
}

/* ---------------------------------------------------------------- Microsoft Graph */

/** The calendar day in this machine's time zone, which is how `after:2026-01-31` was read. */
const isoDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * KQL for Graph's `$search` (the caller wraps the whole thing in double quotes). Dates reach a day, not a moment.
 * Free words search Graph's default properties: from, subject and body.
 */
export function graphSearch(q: ProviderQuery): string {
  const value = (v: string) => {
    const p = plain(v);
    return WORD.test(p) && !/^(OR|AND|NOT)$/.test(p) ? p : `"${p}"`;
  };
  const term = (t: SearchTerm): string => {
    let s: string;
    switch (t.kind) {
      case "text":
        s = value(t.value);
        break;
      case "attachment":
        s = "hasAttachments:true";
        break;
      case "after":
        s = `received>=${isoDay(t.at)}`;
        break;
      case "before":
        s = `received<${isoDay(t.at)}`;
        break;
      default:
        s = `${t.kind}:${value(t.value)}`;
    }
    return t.neg ? `NOT ${s}` : s;
  };
  return q.clauses.map((c) => (c.length === 1 ? term(c[0]!) : `(${c.map(term).join(" OR ")})`)).join(" AND ");
}

/* ---------------------------------------------------------------- IMAP */

const KEYS: (keyof SearchObject)[] = ["from", "to", "subject", "text", "since", "before", "header", "gmraw", "not", "or"];

/** AND of two criteria: one object when no key repeats, otherwise NOT (OR (NOT a) (NOT b)), since an object holds each key once. */
function both(a: SearchObject, b: SearchObject): SearchObject {
  const shared = KEYS.some((k) => a[k] !== undefined && b[k] !== undefined);
  return shared ? { not: { or: [{ not: a }, { not: b }] } } : { ...a, ...b };
}

/**
 * IMAP SEARCH keys for one mailbox of a server that has nothing better than SEARCH. SINCE and BEFORE reach a day and BEFORE leaves
 * out that whole day; IMAP can't ask for attachments, so has:attachment asks for multipart/mixed, which nearly always carries one.
 */
export function imapSearch(q: ProviderQuery): SearchObject {
  const term = (t: SearchTerm): SearchObject => {
    let s: SearchObject;
    switch (t.kind) {
      case "text":
        s = { text: plain(t.value) };
        break;
      case "attachment":
        s = { header: { "content-type": "multipart/mixed" } };
        break;
      case "after":
        s = { since: new Date(t.at) };
        break;
      case "before":
        s = { before: new Date(t.at) };
        break;
      default:
        s = { [t.kind]: plain(t.value) };
    }
    return t.neg ? { not: s } : s;
  };
  return q.clauses
    .map((c): SearchObject => (c.length === 1 ? term(c[0]!) : { or: c.map(term) }))
    .reduce<SearchObject>((acc, c) => both(acc, c), {});
}

/** Gmail's IMAP front end runs Gmail's own search through X-GM-RAW. */
export const imapGmailSearch = (q: ProviderQuery): SearchObject => ({ gmraw: gmailQuery(q) });
