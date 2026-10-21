import type { AppContext } from "../context.ts";
import { isPersonalMailDomain } from "./logos.ts";
import { compile, quotedTerm } from "./query.ts";

/**
 * Tabs worth making, found in the last 30 days of inbox mail with plain counting (no model): mailing lists, companies, calendar
 * invites and receipts that have at least 8 conversations. A group that a custom tab already holds is left out, and so is one the
 * person dismissed. Names and senders come from mail, which anyone can write, so readers treat them as text.
 */

export interface SplitSuggestion {
  /** Stable across calls, so a dismissal can name it: `list:<id>`, `domain:<domain>`, `calendar` or `receipts`. */
  key: string;
  kind: "list" | "domain" | "calendar" | "receipts";
  name: string;
  /** The search the tab would have. */
  query: string;
  /** Conversations from the last 30 days it would hold. */
  count: number;
  /** A few of the people or companies in it. */
  senders: string[];
}

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const MIN_CONVERSATIONS = 8;
const MAX_SUGGESTIONS = 8;
/** Candidates examined per kind before counting what's left of each. */
const PER_KIND = 40;
const DISMISSED_KEY = "splits:dismissed";

// When two suggestions hold the same mail, the more specific one is kept.
const SPECIFICITY: Record<SplitSuggestion["kind"], number> = { list: 0, calendar: 1, receipts: 2, domain: 3 };

const RECEIPTS_QUERY = 'subject:receipt OR subject:invoice OR subject:"order confirmation" OR subject:"your order"';

export function dismissedSuggestions(ctx: AppContext, userId: string): string[] {
  const raw = ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = ?", userId, DISMISSED_KEY)?.value;
  try {
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function dismissSuggestion(ctx: AppContext, userId: string, key: string): void {
  const keep = [...new Set([...dismissedSuggestions(ctx, userId), key])].slice(-500);
  ctx.db.run(
    "INSERT INTO settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
    userId,
    DISMISSED_KEY,
    JSON.stringify(keep),
  );
}

const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim();

/** `agent`: the reader is an agent, so the searches are compiled with the one-time-code guard (see `compile`). */
export function suggestSplits(ctx: AppContext, userId: string, now = Date.now(), opts: { agent?: boolean } = {}): SplitSuggestion[] {
  const { db } = ctx;
  const dismissed = new Set(dismissedSuggestions(ctx, userId));
  const scope = "t.account_id IN (SELECT id FROM accounts WHERE user_id = ?)";
  const window = `${scope} AND t.in_inbox = 1 AND t.last_message_at >= ?`;
  const since = now - WINDOW_DAYS * DAY;
  const ownMail = "m.account_id IN (SELECT id FROM accounts WHERE user_id = ?)";

  // Mail a custom tab that is showing already holds is not offered again.
  const covered = db
    .all<{ query: string }>("SELECT query FROM splits WHERE user_id = ? AND builtin = 0 AND hidden = 0", userId)
    .map((s) => compile(s.query, now, opts))
    .filter((c) => c.where !== "1");
  const notCovered = covered.map((c) => ` AND NOT (${c.where})`).join("");
  const notCoveredParams = covered.flatMap((c) => c.params);

  interface Candidate {
    key: string;
    kind: SplitSuggestion["kind"];
    query: string;
    name: string;
  }
  const candidates: Candidate[] = [];

  const lists = db.all<{ list_id: string }>(
    `SELECT m.list_id FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE ${window} AND m.outgoing = 0 AND m.list_id IS NOT NULL
     GROUP BY m.list_id HAVING count(DISTINCT t.id) >= ? ORDER BY count(DISTINCT t.id) DESC LIMIT ?`,
    userId, since, MIN_CONVERSATIONS, PER_KIND,
  );
  for (const { list_id } of lists) {
    const from = db.get<{ from_name: string }>(
      `SELECT from_name FROM messages m WHERE m.list_id = ? AND m.outgoing = 0 AND m.from_name != '' AND ${ownMail} ORDER BY m.sent_at DESC LIMIT 1`,
      list_id,
      userId,
    );
    candidates.push({ key: `list:${list_id}`, kind: "list", query: quotedTerm("list", list_id), name: cleanName(from?.from_name) || titleCase(list_id.split(".")[0] ?? list_id) });
  }

  const domains = db.all<{ sender_domain: string }>(
    `SELECT m.sender_domain FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE ${window} AND m.outgoing = 0 AND m.sender_domain != ''
     GROUP BY m.sender_domain HAVING count(DISTINCT t.id) >= ? ORDER BY count(DISTINCT t.id) DESC LIMIT ?`,
    userId, since, MIN_CONVERSATIONS, PER_KIND * 2,
  );
  for (const { sender_domain } of domains) {
    if (isPersonalMailDomain(sender_domain)) continue;
    const from = db.get<{ from_name: string }>(
      `SELECT from_name FROM messages m WHERE m.sender_domain = ? AND m.outgoing = 0 AND m.from_name != '' AND ${ownMail}
       GROUP BY m.from_name ORDER BY count(*) DESC LIMIT 1`,
      sender_domain,
      userId,
    );
    candidates.push({
      key: `domain:${sender_domain}`,
      kind: "domain",
      query: quotedTerm("domain", sender_domain),
      name: cleanName(from?.from_name) || titleCase(sender_domain.split(".")[0] ?? sender_domain),
    });
  }

  candidates.push({ key: "calendar", kind: "calendar", query: "filename:ics", name: "Calendar invites" });
  candidates.push({ key: "receipts", kind: "receipts", query: RECEIPTS_QUERY, name: "Receipts" });

  // What each candidate would hold now, minus what a custom tab holds.
  const found: (SplitSuggestion & { ids: Set<string> })[] = [];
  for (const c of candidates) {
    if (dismissed.has(c.key)) continue;
    const q = compile(c.query, now, opts);
    const rows = db.all<{ id: string; participants: string }>(
      `SELECT t.id, t.participants FROM threads t WHERE ${window} AND (${q.where})${notCovered} ORDER BY t.sort_at DESC`,
      userId, since, ...q.params, ...notCoveredParams,
    );
    if (rows.length < MIN_CONVERSATIONS) continue;
    const senders: string[] = [];
    for (const r of rows.slice(0, 40)) {
      const p = (JSON.parse(r.participants) as { name: string; email: string }[])[0];
      const who = cleanName(p?.name) || p?.email;
      if (who && !senders.includes(who)) senders.push(who);
      if (senders.length === 3) break;
    }
    found.push({ key: c.key, kind: c.kind, name: c.name, query: c.query, count: rows.length, senders, ids: new Set(rows.map((r) => r.id)) });
  }

  // Biggest first; a suggestion that mostly repeats mail already offered (a company and its own newsletter) is dropped.
  found.sort((a, b) => b.count - a.count || SPECIFICITY[a.kind] - SPECIFICITY[b.kind]);
  const taken = new Set<string>();
  const out: SplitSuggestion[] = [];
  for (const f of found) {
    let overlap = 0;
    for (const id of f.ids) if (taken.has(id)) overlap++;
    if (overlap * 2 >= f.ids.size) continue;
    for (const id of f.ids) taken.add(id);
    const { ids: _ids, ...suggestion } = f;
    out.push(suggestion);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/** A sender's display name as a tab name: short, and not an address. */
function cleanName(name: string | undefined): string {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  return n.length > 0 && n.length <= 40 && !n.includes("@") ? n : "";
}
