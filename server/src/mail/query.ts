/**
 * Slipstream's search language, shared by search and by splits.
 *
 *   from:ana  to:@acme.com  subject:"q3 plan"  label:clients  has:attachment
 *   is:unread is:starred is:snoozed is:done is:vip is:muted is:important
 *   in:inbox|sent|trash|spam|done|snoozed|all   category:news|notification|important|other
 *   after:2026-01-31  before:2026-03-01  newer:7d  older:2w   account:me@work.com
 *   -from:ana (negation)   a OR b   "exact phrase"   free text (full-text, prefix match)
 *
 * Compiles to a WHERE clause over `threads t`.
 */

export interface Term {
  neg: boolean;
  key: string | null;
  value: string;
}

export type Clause = Term[]; // OR-group: any term may match

export function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /(-?[a-z_]+:"[^"]*"|-?"[^"]*"|\(|\)|[^\s()]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1]!);
  return out;
}

/** Parse into AND-of-ORs. Parentheses are tolerated and ignored. */
export function parse(input: string): Clause[] {
  const clauses: Clause[] = [];
  let pendingOr = false;
  for (const tok of tokenize(input)) {
    if (tok === "(" || tok === ")") continue;
    if (tok === "OR" || tok === "|") {
      pendingOr = clauses.length > 0;
      continue;
    }
    if (tok === "AND") continue;
    const term = parseTerm(tok);
    if (!term) continue;
    if (pendingOr) clauses[clauses.length - 1]!.push(term);
    else clauses.push([term]);
    pendingOr = false;
  }
  return clauses;
}

const KEYS = new Set([
  "from", "to", "cc", "subject", "label", "has", "is", "in", "category", "after", "before", "newer", "older", "account", "filename",
]);
const ALIASES: Record<string, string> = { newer_than: "newer", older_than: "older", since: "after", until: "before" };

function parseTerm(tok: string): Term | null {
  let neg = false;
  let t = tok;
  if (t.startsWith("-") && t.length > 1) {
    neg = true;
    t = t.slice(1);
  }
  const colon = t.indexOf(":");
  if (colon > 0) {
    let key = t.slice(0, colon).toLowerCase();
    key = ALIASES[key] ?? key;
    if (KEYS.has(key)) {
      const value = unquote(t.slice(colon + 1));
      if (!value) return null;
      return { neg, key, value };
    }
  }
  const value = unquote(t);
  return value ? { neg, key: null, value } : null;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

export interface Compiled {
  where: string;
  params: (string | number)[];
  /** True when the query names a location (in:/is:done/is:snoozed); otherwise callers add a default scope. */
  scoped: boolean;
}

const DAY = 86_400_000;

export function parseRelative(v: string, now: number): number | null {
  const m = /^(\d+)\s*([hdwmy])$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { h: DAY / 24, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[m[2]!.toLowerCase() as "h"]!;
  return now - n * unit;
}

function parseDate(v: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Quote free text for FTS5: every word becomes a prefix match, phrases stay phrases. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  if (text.includes(" ") && words.length > 1 && /^".*"$/.test(text.trim())) return `"${words.join(" ")}"`;
  return words.map((w) => `"${w}"*`).join(" ");
}

export function compile(input: string, now = Date.now()): Compiled {
  const clauses = parse(input);
  const parts: string[] = [];
  const params: (string | number)[] = [];
  let scoped = false;

  for (const clause of clauses) {
    const ors: string[] = [];
    for (const term of clause) {
      const sql = termSql(term, params, now);
      if (!sql) continue;
      if (term.key === "in" || (term.key === "is" && ["done", "snoozed", "reminded"].includes(term.value))) scoped = true;
      ors.push(term.neg ? `NOT (${sql})` : `(${sql})`);
    }
    if (ors.length) parts.push(ors.length === 1 ? ors[0]! : `(${ors.join(" OR ")})`);
  }
  return { where: parts.length ? parts.join(" AND ") : "1", params, scoped };
}

function termSql(term: Term, params: (string | number)[], now: number): string | null {
  const v = term.value;
  const lv = v.toLowerCase();
  const msgExists = (cond: string) => `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND ${cond})`;
  switch (term.key) {
    case null: {
      const q = ftsQuery(v);
      if (!q) return null;
      params.push(q);
      return `t.id IN (SELECT m.thread_id FROM messages m WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?))`;
    }
    case "from":
      params.push(like(lv), like(lv));
      return msgExists(`(m.from_email LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')`);
    case "to":
      params.push(like(lv));
      return msgExists(`m.to_json LIKE ? ESCAPE '\\'`);
    case "cc":
      params.push(like(lv));
      return msgExists(`m.cc_json LIKE ? ESCAPE '\\'`);
    case "subject":
      params.push(like(lv));
      return `t.subject LIKE ? ESCAPE '\\'`;
    case "filename":
      params.push(like(lv));
      return `EXISTS (SELECT 1 FROM messages m JOIN attachments a ON a.message_id = m.id WHERE m.thread_id = t.id AND a.filename LIKE ? ESCAPE '\\')`;
    case "label":
      params.push(lv);
      return `EXISTS (SELECT 1 FROM thread_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.thread_id = t.id AND lower(l.name) = ?)`;
    case "account":
      params.push(lv);
      return `t.account_id IN (SELECT id FROM accounts WHERE lower(email) = ?)`;
    case "category":
      if (lv === "other") return `t.category != 'important'`;
      params.push(lv);
      return `t.category = ?`;
    case "has":
      if (lv === "attachment" || lv === "attachments") return `t.has_attachments = 1`;
      if (lv === "reply" || lv === "replied") return `t.in_sent = 1`;
      return null;
    case "is":
      switch (lv) {
        case "unread": return `t.unread_count > 0`;
        case "read": return `t.unread_count = 0`;
        case "starred": return `t.starred = 1`;
        case "snoozed": return `t.snoozed_until IS NOT NULL`;
        case "reminded": return `t.reminded_at IS NOT NULL AND t.in_inbox = 1`;
        case "done": return `t.in_inbox = 0 AND t.in_trash = 0 AND t.in_spam = 0 AND t.snoozed_until IS NULL`;
        case "muted": return `t.muted = 1`;
        case "important": return `t.category = 'important'`;
        case "vip":
          return `EXISTS (SELECT 1 FROM messages m JOIN contacts c ON c.account_id = m.account_id AND c.email = m.from_email
                   WHERE m.thread_id = t.id AND c.vip = 1)`;
        case "noreply":
        case "unanswered":
          return `t.last_inbound_at IS NOT NULL AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at)`;
        default: return null;
      }
    case "in":
      switch (lv) {
        case "inbox": return `t.in_inbox = 1`;
        case "sent": return `t.in_sent = 1`;
        case "trash": return `t.in_trash = 1`;
        case "spam": return `t.in_spam = 1`;
        case "done":
        case "archive": return `t.in_inbox = 0 AND t.in_trash = 0 AND t.in_spam = 0 AND t.snoozed_until IS NULL`;
        case "snoozed":
        case "reminders": return `t.snoozed_until IS NOT NULL`;
        case "starred": return `t.starred = 1`;
        case "all":
        case "anywhere": return `1`;
        default: return null;
      }
    case "after": {
      const d = parseDate(v) ?? parseRelative(v, now);
      if (d === null) return null;
      params.push(d);
      return `t.last_message_at >= ?`;
    }
    case "before": {
      const d = parseDate(v) ?? parseRelative(v, now);
      if (d === null) return null;
      params.push(d);
      return `t.last_message_at < ?`;
    }
    case "newer": {
      const d = parseRelative(v, now);
      if (d === null) return null;
      params.push(d);
      return `t.last_message_at >= ?`;
    }
    case "older": {
      const d = parseRelative(v, now);
      if (d === null) return null;
      params.push(d);
      return `t.last_message_at < ?`;
    }
    default:
      return null;
  }
}
