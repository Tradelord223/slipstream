import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import type { ServerEvent } from "../events.ts";
import { compile } from "../mail/query.ts";
import type { AccountRow } from "../mail/store.ts";

interface SplitRow {
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
  labels: string | null;
}

const LIST_COLUMNS = `t.id, t.account_id, t.subject, t.snippet, t.participants, t.last_message_at, t.sort_at, t.message_count,
  t.unread_count, t.starred, t.has_attachments, t.snoozed_until, t.reminded_at, t.follow_up_at, t.category, t.in_inbox, t.in_trash,
  (SELECT group_concat(l.name, char(31)) FROM thread_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.thread_id = t.id) AS labels`;

export function shapeRow(r: ThreadListRow) {
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    participants: JSON.parse(r.participants) as { name: string; email: string }[],
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
  };
}

/** WHERE clause for a split: its own query, scoped to the inbox, minus custom splits for the built-ins. */
export function splitWhere(split: SplitRow, all: SplitRow[], now: number): { where: string; params: (string | number)[] } {
  const own = compile(split.query, now);
  const parts = [own.where];
  const params = [...own.params];
  if (!own.scoped) parts.push("t.in_inbox = 1");
  if (split.builtin) {
    for (const s of all) {
      if (s.builtin) continue;
      const other = compile(s.query, now);
      parts.push(`NOT (${other.where})`);
      params.push(...other.params);
    }
  }
  return { where: parts.join(" AND "), params };
}

const listQuery = z.object({
  view: z.enum(["inbox", "split", "search"]).default("inbox"),
  split: z.string().optional(),
  q: z.string().max(500).optional(),
  account: z.string().optional(),
  before: z.string().optional(), // cursor "sortAt:id"
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const triageBody = z.object({
  kind: z.enum([
    "done", "undone", "trash", "untrash", "spam", "unspam", "read", "unread", "star", "unstar",
    "snooze", "unsnooze", "mute", "unmute", "addLabel", "removeLabel",
  ]),
  threadIds: z.array(z.string()).min(1).max(5000),
  until: z.number().int().optional(),
  label: z.string().max(200).optional(),
});

export function mailRoutes(ctx: AppContext) {
  const { db, triage, store, events, sync } = ctx;
  const app = new Hono<Env>();

  const userAccounts = (userId: string) =>
    db.all<AccountRow>("SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at", userId);

  app.get("/threads", (c) => {
    const user = c.get("user");
    const q = listQuery.parse(c.req.query());
    const now = Date.now();
    const where: string[] = ["t.account_id IN (SELECT id FROM accounts WHERE user_id = ?)"];
    const params: (string | number)[] = [user.id];

    if (q.account) {
      where.push("t.account_id = ?");
      params.push(q.account);
    }

    if (q.view === "search") {
      const compiled = compile(q.q ?? "", now);
      where.push(compiled.where);
      params.push(...compiled.params);
      if (!compiled.scoped) where.push("t.in_trash = 0 AND t.in_spam = 0");
    } else if (q.view === "split" && q.split) {
      const splits = db.all<SplitRow>("SELECT * FROM splits WHERE user_id = ? ORDER BY position", user.id);
      const split = splits.find((s) => s.id === q.split);
      if (!split) throw new HttpError(404, "Split not found");
      const s = splitWhere(split, splits, now);
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

    const started = performance.now();
    const rows = db.all<ThreadListRow>(
      `SELECT ${LIST_COLUMNS} FROM threads t WHERE ${where.join(" AND ")} ORDER BY t.sort_at DESC, t.id DESC LIMIT ?`,
      ...params,
      q.limit + 1,
    );
    const ms = performance.now() - started;
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit).map(shapeRow);
    const last = page.at(-1);
    c.header("Server-Timing", `db;dur=${ms.toFixed(2)}`);
    return c.json({ threads: page, next: more && last ? `${last.sortAt}:${last.id}` : null });
  });

  app.get("/counts", (c) => {
    const user = c.get("user");
    const now = Date.now();
    const splits = db.all<SplitRow>("SELECT * FROM splits WHERE user_id = ? ORDER BY position", user.id);
    const scope = "t.account_id IN (SELECT id FROM accounts WHERE user_id = ?)";
    const out: Record<string, { total: number; unread: number }> = {};
    for (const s of splits) {
      const w = splitWhere(s, splits, now);
      out[s.id] = db.get<{ total: number; unread: number }>(
        `SELECT count(*) AS total, coalesce(sum(t.unread_count > 0), 0) AS unread FROM threads t WHERE ${scope} AND ${w.where}`,
        user.id,
        ...w.params,
      )!;
    }
    const inbox = db.get<{ total: number; unread: number }>(
      `SELECT count(*) AS total, coalesce(sum(t.unread_count > 0), 0) AS unread FROM threads t WHERE ${scope} AND t.in_inbox = 1`,
      user.id,
    )!;
    const reminders = db.get<{ n: number }>(
      `SELECT count(*) AS n FROM threads t WHERE ${scope} AND t.snoozed_until IS NOT NULL`,
      user.id,
    )!.n;
    const doneToday = db.get<{ n: number }>(
      `SELECT count(*) AS n FROM threads t WHERE ${scope} AND t.done_at >= ?`,
      user.id,
      new Date().setHours(0, 0, 0, 0),
    )!.n;
    return c.json({ splits: out, inbox, reminders, doneToday });
  });

  app.get("/threads/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const row = db.get<ThreadListRow>(
      `SELECT ${LIST_COLUMNS} FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND a.user_id = ?`,
      id,
      user.id,
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
      }>(
        `SELECT id, from_name, from_email, to_json, cc_json, bcc_json, reply_to, subject, sent_at, snippet, body_text, body_html,
                unread, outgoing, list_unsubscribe, message_id_header
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
        attachments: db
          .all<{ id: string; filename: string; mime_type: string; size: number; content_id: string | null; inline: number }>(
            "SELECT id, filename, mime_type, size, content_id, inline FROM attachments WHERE message_id = ?",
            m.id,
          )
          .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size, contentId: a.content_id, inline: Boolean(a.inline) })),
      }));
    const draft = db.get<{ id: string }>(
      "SELECT id FROM drafts WHERE thread_id = ? AND user_id = ? AND status IN ('draft','failed') ORDER BY updated_at DESC LIMIT 1",
      id,
      user.id,
    );
    const shared = db.get<{ id: string }>("SELECT id FROM shared_threads WHERE source_thread_id = ?", id);
    return c.json({ thread: shapeRow(row), messages, draftId: draft?.id ?? null, sharedId: shared?.id ?? null });
  });

  app.post("/triage", async (c) => {
    const body = triageBody.parse(await c.req.json());
    const result = triage.apply(c.get("user").id, body);
    emitThreads(ctx, c.get("user").id, result.threadIds);
    return c.json(result);
  });

  app.post("/undo", async (c) => {
    const { undoToken } = z.object({ undoToken: z.string() }).parse(await c.req.json());
    const ids = triage.revert(c.get("user").id, undoToken);
    emitThreads(ctx, c.get("user").id, ids);
    return c.json({ threadIds: ids });
  });

  /** Get Me To Zero: mark everything older than a cutoff as done, in one undoable step. */
  app.post("/zero", async (c) => {
    const user = c.get("user");
    const body = z
      .object({ olderThanDays: z.number().int().min(0).max(3650), keepStarred: z.boolean().default(true), keepUnread: z.boolean().default(false) })
      .parse(await c.req.json());
    const cutoff = Date.now() - body.olderThanDays * 86_400_000;
    const ids = db
      .all<{ id: string }>(
        `SELECT t.id FROM threads t JOIN accounts a ON a.id = t.account_id
         WHERE a.user_id = ? AND t.in_inbox = 1 AND t.sort_at < ? ${body.keepStarred ? "AND t.starred = 0" : ""} ${body.keepUnread ? "AND t.unread_count = 0" : ""}`,
        user.id,
        cutoff,
      )
      .map((r) => r.id);
    if (ids.length === 0) return c.json({ undoToken: null, threadIds: [] });
    const result = triage.apply(user.id, { kind: "done", threadIds: ids });
    emitThreads(ctx, user.id, ids);
    return c.json(result);
  });

  app.get("/contacts", (c) => {
    const user = c.get("user");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const rows = db.all<{ email: string; name: string; vip: number }>(
      `SELECT c.email, max(c.name) AS name, max(c.vip) AS vip FROM contacts c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND (c.email LIKE ? OR lower(c.name) LIKE ? OR lower(c.name) LIKE ?)
       GROUP BY c.email ORDER BY sum(c.sent_count) * 4 + sum(c.received_count) DESC, max(c.last_seen_at) DESC LIMIT 8`,
      user.id,
      `${q}%`,
      `${q}%`,
      `% ${q}%`,
    );
    return c.json({ contacts: rows.map((r) => ({ email: r.email, name: r.name, vip: Boolean(r.vip) })) });
  });

  app.get("/contacts/:email", (c) => {
    const user = c.get("user");
    const email = c.req.param("email").toLowerCase();
    const info = db.get<{ name: string; sent: number; received: number; last: number; vip: number }>(
      `SELECT max(c.name) AS name, sum(c.sent_count) AS sent, sum(c.received_count) AS received, max(c.last_seen_at) AS last, max(c.vip) AS vip
       FROM contacts c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? AND c.email = ?`,
      user.id,
      email,
    );
    const recent = db
      .all<ThreadListRow>(
        `SELECT ${LIST_COLUMNS} FROM threads t WHERE t.account_id IN (SELECT id FROM accounts WHERE user_id = ?)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.from_email = ?) ORDER BY t.sort_at DESC LIMIT 5`,
        user.id,
        email,
      )
      .map(shapeRow);
    return c.json({ email, name: info?.name ?? "", sent: info?.sent ?? 0, received: info?.received ?? 0, lastSeenAt: info?.last ?? null, vip: Boolean(info?.vip), recent });
  });

  app.post("/contacts/:email/vip", async (c) => {
    const user = c.get("user");
    const { vip } = z.object({ vip: z.boolean() }).parse(await c.req.json());
    db.run(
      "UPDATE contacts SET vip = ? WHERE email = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)",
      vip ? 1 : 0,
      c.req.param("email").toLowerCase(),
      user.id,
    );
    return c.json({ ok: true });
  });

  app.get("/attachments/:id", async (c) => {
    const user = c.get("user");
    const att = db.get<{
      id: string;
      filename: string;
      mime_type: string;
      blob_sha256: string | null;
      remote_id: string | null;
      message_remote_id: string;
      account_id: string;
    }>(
      `SELECT at.id, at.filename, at.mime_type, at.blob_sha256, at.remote_id, m.remote_id AS message_remote_id, m.account_id
       FROM attachments at JOIN messages m ON m.id = at.message_id JOIN accounts a ON a.id = m.account_id
       WHERE at.id = ? AND a.user_id = ?`,
      c.req.param("id"),
      user.id,
    );
    if (!att) throw new HttpError(404, "Attachment not found");
    let content = att.blob_sha256 ? store.readBlob(att.blob_sha256) : null;
    if (!content && att.remote_id) {
      const account = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", att.account_id)!;
      const provider = sync.provider(account);
      if (!provider.fetchAttachment) throw new HttpError(404, "This attachment isn't available offline");
      content = await provider.fetchAttachment(att.message_remote_id, att.remote_id);
      db.run("UPDATE attachments SET blob_sha256 = ? WHERE id = ?", store.saveBlob(content), att.id);
    }
    if (!content) throw new HttpError(404, "This attachment isn't available offline");
    // Only raster images render inline (cid: images in message bodies). Everything else downloads.
    const inlineSafe = c.req.query("inline") === "1" && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.mime_type);
    return c.body(new Uint8Array(content), 200, {
      "content-type": inlineSafe ? att.mime_type : "application/octet-stream",
      "content-disposition": `${inlineSafe ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=86400",
    });
  });

  /** One-key unsubscribe: mailto targets get an email sent for you; web targets come back to open. */
  app.post("/threads/:id/unsubscribe", async (c) => {
    const user = c.get("user");
    const msg = db.get<{ list_unsubscribe: string; account_id: string }>(
      `SELECT m.list_unsubscribe, m.account_id FROM messages m JOIN accounts a ON a.id = m.account_id
       WHERE m.thread_id = ? AND a.user_id = ? AND m.list_unsubscribe IS NOT NULL ORDER BY m.sent_at DESC LIMIT 1`,
      c.req.param("id"),
      user.id,
    );
    if (!msg) throw new HttpError(404, "This sender didn't include an unsubscribe link.");
    const targets = [...msg.list_unsubscribe.matchAll(/<([^>]+)>|((?:https?|mailto):[^\s,]+)/g)].map((m) => (m[1] ?? m[2])!.trim());
    const web = targets.find((t) => /^https:\/\//i.test(t));
    const mailto = targets.find((t) => /^mailto:/i.test(t));
    const result = triage.apply(user.id, { kind: "done", threadIds: [c.req.param("id")] });
    emitThreads(ctx, user.id, result.threadIds);
    if (mailto) {
      const url = new URL(mailto);
      const now = Date.now();
      const id = `drf_unsub_${now.toString(36)}`;
      db.run(
        `INSERT INTO drafts (id, user_id, account_id, to_json, subject, body_html, send_at, status, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        user.id,
        msg.account_id,
        JSON.stringify([{ name: "", email: decodeURIComponent(url.pathname) }]),
        url.searchParams.get("subject") ?? "unsubscribe",
        `<p>${url.searchParams.get("body") ?? "unsubscribe"}</p>`,
        now,
        "scheduled",
        now,
      );
      return c.json({ method: "email", undoToken: result.undoToken });
    }
    return c.json({ method: "web", url: web ?? null, undoToken: result.undoToken });
  });

  app.get("/events", (c) => {
    const user = c.get("user");
    const workspace = ctx.users.workspaceOf(user.id);
    return streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = events.subscribe(
        [`user:${user.id}`, ...(workspace ? [`ws:${workspace.id}`] : [])],
        (e) => {
          queue.push(e);
          wake?.();
        },
      );
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (!stream.aborted) {
        if (queue.length === 0) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
          wake = null;
          if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        const e = queue.shift()!;
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      }
      unsubscribe();
    });
  });

  app.get("/bootstrap", (c) => {
    const user = c.get("user");
    const accounts = userAccounts(user.id).map((a) => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      name: a.name,
      color: a.color,
      syncStatus: a.sync_status,
      syncError: a.sync_error,
      lastSyncedAt: a.last_synced_at,
    }));
    const splits = db
      .all<SplitRow>("SELECT * FROM splits WHERE user_id = ? ORDER BY position", user.id)
      .map((s) => ({ id: s.id, name: s.name, query: s.query, builtin: Boolean(s.builtin) }));
    const labels = db.all<{ name: string }>(
      `SELECT DISTINCT l.name FROM labels l JOIN accounts a ON a.id = l.account_id WHERE a.user_id = ? AND l.kind = 'user' ORDER BY l.name`,
      user.id,
    );
    const settings = Object.fromEntries(
      db
        .all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE user_id = ? AND key NOT LIKE 'secret:%'", user.id)
        .map((r) => [r.key, JSON.parse(r.value)]),
    );
    return c.json({
      mode: ctx.config.mode,
      user,
      workspace: ctx.users.workspaceOf(user.id),
      accounts,
      splits,
      labels: labels.map((l) => l.name),
      settings,
      features: {
        ai: Boolean(ctx.config.anthropicApiKey || db.get("SELECT 1 AS x FROM settings WHERE user_id = ? AND key = 'secret:anthropic'", user.id)),
        google: Boolean(ctx.config.google.clientId),
        microsoft: Boolean(ctx.config.microsoft.clientId),
        undoSendSeconds: ctx.config.undoSendSeconds,
      },
    });
  });

  return app;
}

export function emitThreads(ctx: AppContext, userId: string, threadIds: string[]) {
  if (threadIds.length === 0) return;
  ctx.events.emitToUser(userId, { type: "threads", accountId: "", threadIds });
}
