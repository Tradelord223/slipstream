import { logoDomain } from "./logos.ts";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";
import { compile } from "./query.ts";
import { maskCodes, type Signal } from "./signals.ts";

/**
 * Read models shared by the dashboard's REST routes and the agent command registry:
 * thread lists (inbox, splits, search), counts and a full conversation.
 */

export interface SplitRow {
  id: string;
  name: string;
  query: string;
  position: number;
  builtin: number;
}

export interface ThreadListRow {
  id: string;
  account_id: string;
  subject: string;
  snippet: string;
  participants: string;
  last_message_at: number;
  sort_at: number;
  message_count: number;
  unread_count: number;
  starred: number;
  has_attachments: number;
  snoozed_until: number | null;
  reminded_at: number | null;
  follow_up_at: number | null;
  category: string;
  in_inbox: number;
  in_trash: number;
  signal: string | null;
  signal_at: number | null;
  labels: string | null;
}

export const LIST_COLUMNS = `t.id, t.account_id, t.subject, t.snippet, t.participants, t.last_message_at, t.sort_at, t.message_count,
  t.unread_count, t.starred, t.has_attachments, t.snoozed_until, t.reminded_at, t.follow_up_at, t.category, t.in_inbox, t.in_trash,
  t.signal, t.signal_at,
  (SELECT group_concat(l.name, char(31)) FROM thread_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.thread_id = t.id) AS labels`;

export function shapeRow(r: ThreadListRow) {
  // threads.signal is an array, most important first. A bare object (written before it became one) reads as a list of one.
  const parsed = r.signal ? (JSON.parse(r.signal) as Signal | Signal[]) : null;
  const signals = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const detail = signals[0] ?? null;
  const participants = JSON.parse(r.participants) as { name: string; email: string }[];
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    participants,
    lastMessageAt: r.last_message_at,
    sortAt: r.sort_at,
    messageCount: r.message_count,
    unread: r.unread_count > 0,
    starred: Boolean(r.starred),
    hasAttachments: Boolean(r.has_attachments),
    snoozedUntil: r.snoozed_until,
    remindedAt: r.reminded_at,
    followUpAt: r.follow_up_at,
    category: r.category,
    inInbox: Boolean(r.in_inbox),
    inTrash: Boolean(r.in_trash),
    labels: r.labels ? r.labels.split("\u001f") : [],
    signal: detail?.kind ?? null,
    signalAt: detail ? r.signal_at : null,
    signalDetail: detail,
    signals,
    // Where /api/logos can find a company mark for this row; people never get one.
    logoDomain: r.category !== "important" && participants[0] ? logoDomain(participants[0].email) : null,
  };
}

/** For readers that must not see one-time codes (agents): the subject and snippet of a row with the code masked. */
const hideRowCodes = (r: ReturnType<typeof shapeRow>) => ({ ...r, ...maskCodes({ subject: r.subject, snippet: r.snippet }) });

/** WHERE clause for a split: its own query, scoped to the inbox, minus custom splits for the built-ins. */
export function splitWhere(split: SplitRow, all: SplitRow[], now: number, opts: { hideCodes?: boolean } = {}): { where: string; params: (string | number)[] } {
  const own = compile(split.query, now, { agent: opts.hideCodes });
  const parts = [own.where];
  const params = [...own.params];
  if (!own.scoped) parts.push("t.in_inbox = 1");
  if (split.builtin) {
    for (const s of all) {
      if (s.builtin) continue;
      const other = compile(s.query, now, { agent: opts.hideCodes });
      parts.push(`NOT (${other.where})`);
      params.push(...other.params);
    }
  }
  return { where: parts.join(" AND "), params };
}

export const listQuerySchema = z.object({
  view: z.enum(["inbox", "split", "search"]).default("inbox"),
  split: z.string().optional(),
  q: z.string().max(500).optional(),
  account: z.string().optional(),
  before: z.string().optional(), // cursor "sortAt:id"
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export function listThreads(ctx: AppContext, userId: string, q: ListQuery, opts: { hideCodes?: boolean } = {}) {
  const { db } = ctx;
  const now = Date.now();
  const where: string[] = ["t.account_id IN (SELECT id FROM accounts WHERE user_id = ?)"];
  const params: (string | number)[] = [userId];

  if (q.account) {
    where.push("t.account_id = ?");
    params.push(q.account);
  }

  if (q.view === "search") {
    const compiled = compile(q.q ?? "", now, { agent: opts.hideCodes });
    where.push(compiled.where);
    params.push(...compiled.params);
    if (!compiled.scoped) where.push("t.in_trash = 0 AND t.in_spam = 0");
  } else if (q.view === "split" && q.split) {
    const splits = db.all<SplitRow>("SELECT * FROM splits WHERE user_id = ? ORDER BY position", userId);
    const split = splits.find((s) => s.id === q.split);
    if (!split) throw new HttpError(404, "Split not found");
    const s = splitWhere(split, splits, now, opts);
    where.push(s.where);
    params.push(...s.params);
  } else {
    where.push("t.in_inbox = 1");
  }

  if (q.before) {
    const [sortAt, id] = q.before.split(":");
    where.push("(t.sort_at < ? OR (t.sort_at = ? AND t.id < ?))");
    params.push(Number(sortAt), Number(sortAt), id ?? "");
  }

  const rows = db.all<ThreadListRow>(
    `SELECT ${LIST_COLUMNS} FROM threads t WHERE ${where.join(" AND ")} ORDER BY t.sort_at DESC, t.id DESC LIMIT ?`,
    ...params,
    q.limit + 1,
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit).map(shapeRow).map((r) => (opts.hideCodes ? hideRowCodes(r) : r));
  const last = page.at(-1);
  return { threads: page, next: more && last ? `${last.sortAt}:${last.id}` : null };
}

export function counts(ctx: AppContext, userId: string, opts: { hideCodes?: boolean } = {}) {
  const { db } = ctx;
  const now = Date.now();
  const splits = db.all<SplitRow>("SELECT * FROM splits WHERE user_id = ? ORDER BY position", userId);
  const scope = "t.account_id IN (SELECT id FROM accounts WHERE user_id = ?)";
  const out: Record<string, { total: number; unread: number }> = {};
  for (const s of splits) {
    const w = splitWhere(s, splits, now, opts);
    out[s.id] = db.get<{ total: number; unread: number }>(
      `SELECT count(*) AS total, coalesce(sum(t.unread_count > 0), 0) AS unread FROM threads t WHERE ${scope} AND ${w.where}`,
      userId,
      ...w.params,
    )!;
  }
  const inbox = db.get<{ total: number; unread: number }>(
    `SELECT count(*) AS total, coalesce(sum(t.unread_count > 0), 0) AS unread FROM threads t WHERE ${scope} AND t.in_inbox = 1`,
    userId,
  )!;
  const reminders = db.get<{ n: number }>(`SELECT count(*) AS n FROM threads t WHERE ${scope} AND t.snoozed_until IS NOT NULL`, userId)!.n;
  const doneToday = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM threads t WHERE ${scope} AND t.done_at >= ?`,
    userId,
    new Date().setHours(0, 0, 0, 0),
  )!.n;
  return { splits: out, inbox, reminders, doneToday };
}

export function getThread(ctx: AppContext, userId: string, id: string, opts: { hideCodes?: boolean } = {}) {
  const { db } = ctx;
  const row = db.get<ThreadListRow>(
    `SELECT ${LIST_COLUMNS} FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND a.user_id = ?`,
    id,
    userId,
  );
  if (!row) throw new HttpError(404, "Conversation not found");
  const messages = db
    .all<{
      id: string;
      from_name: string;
      from_email: string;
      to_json: string;
      cc_json: string;
      bcc_json: string;
      reply_to: string | null;
      subject: string;
      sent_at: number;
      snippet: string;
      body_text: string;
      body_html: string | null;
      unread: number;
      outgoing: number;
      list_unsubscribe: string | null;
      message_id_header: string | null;
      is_bulk: number;
      signals: string | null;
    }>(
      `SELECT id, from_name, from_email, to_json, cc_json, bcc_json, reply_to, subject, sent_at, snippet, body_text, body_html,
              unread, outgoing, list_unsubscribe, message_id_header, is_bulk, signals
       FROM messages WHERE thread_id = ? ORDER BY sent_at`,
      id,
    )
    .map((m) => ({
      id: m.id,
      from: { name: m.from_name, email: m.from_email },
      to: JSON.parse(m.to_json),
      cc: JSON.parse(m.cc_json),
      bcc: JSON.parse(m.bcc_json),
      replyTo: m.reply_to,
      subject: m.subject,
      sentAt: m.sent_at,
      snippet: m.snippet,
      text: m.body_text,
      html: m.body_html,
      unread: Boolean(m.unread),
      outgoing: Boolean(m.outgoing),
      canUnsubscribe: Boolean(m.list_unsubscribe),
      isBulk: Boolean(m.is_bulk),
      logoDomain: m.is_bulk && !m.outgoing ? logoDomain(m.from_email) : null,
      signals: m.signals ? (JSON.parse(m.signals) as Signal[]) : [],
      attachments: db
        .all<{ id: string; filename: string; mime_type: string; size: number; content_id: string | null; inline: number }>(
          "SELECT id, filename, mime_type, size, content_id, inline FROM attachments WHERE message_id = ?",
          m.id,
        )
        .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size, contentId: a.content_id, inline: Boolean(a.inline) })),
    }))
    .map((m) => (opts.hideCodes ? maskCodes(m) : m));
  const draft = db.get<{ id: string }>(
    "SELECT id FROM drafts WHERE thread_id = ? AND user_id = ? AND status IN ('draft','failed') ORDER BY updated_at DESC LIMIT 1",
    id,
    userId,
  );
  const shared = db.get<{ id: string }>("SELECT id FROM shared_threads WHERE source_thread_id = ?", id);
  return { thread: opts.hideCodes ? hideRowCodes(shapeRow(row)) : shapeRow(row), messages, draftId: draft?.id ?? null, sharedId: shared?.id ?? null };
}
