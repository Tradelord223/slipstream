import { Hono } from "hono";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import type { ServerEvent } from "../events.ts";
import { assistantSetting } from "../agents/assistant.ts";
import { triageCommandName } from "../commands/catalog.ts";
import { listIdentities } from "../mail/identities.ts";
import { extractCode } from "../mail/signals.ts";
import { unsubscribe } from "../mail/unsubscribe.ts";
import { counts, getThread, LIST_COLUMNS, listQuerySchema, listThreads, shapeRow, type SplitRow, type ThreadListRow } from "../mail/views.ts";
import type { AccountRow } from "../mail/store.ts";

const triageBody = z.object({
  kind: z.enum([
    "done", "undone", "trash", "untrash", "spam", "unspam", "read", "unread", "star", "unstar",
    "snooze", "unsnooze", "mute", "unmute", "addLabel", "removeLabel",
  ]),
  threadIds: z.array(z.string()).min(1).max(5000),
  until: z.number().int().optional(),
  label: z.string().max(200).optional(),
});


/** Settings that belong to other features and aren't sent with the dashboard's preferences. */
const INTERNAL_SETTINGS = new Set(["cloudAgent", "engines", "agentBudgets", "autopilot"]);
export function mailRoutes(ctx: AppContext) {
  const { db, triage, store, events, sync } = ctx;
  const app = new Hono<Env>();

  const userAccounts = (userId: string) =>
    db.all<AccountRow>("SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at", userId);

  app.get("/threads", (c) => {
    const started = performance.now();
    const result = listThreads(ctx, c.get("user").id, listQuerySchema.parse(c.req.query()));
    c.header("Server-Timing", `db;dur=${(performance.now() - started).toFixed(2)}`);
    return c.json(result);
  });

  app.get("/counts", (c) => c.json(counts(ctx, c.get("user").id)));

  app.get("/threads/:id", (c) => c.json(getThread(ctx, c.get("user").id, c.req.param("id"))));

  /**
   * A one-time code, found again in the message when a person asks. People only: an agent never gets
   * one (the command registry masks codes for agents, and agent tokens can't reach /api/messages anyway).
   */
  app.get("/messages/:id/code", (c) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can read a sign-in code.");
    const m = db.get<{ subject: string; body_text: string }>(
      `SELECT m.subject, m.body_text FROM messages m JOIN accounts a ON a.id = m.account_id
       WHERE m.id = ? AND a.user_id = ? AND m.outgoing = 0`,
      c.req.param("id"),
      c.get("user").id,
    );
    const code = m ? extractCode(m.subject, m.body_text) : null;
    if (!code) throw new HttpError(404, "No code in that message");
    c.header("Cache-Control", "no-store");
    return c.json({ code });
  });

  /** The freshest code in a conversation, so a list row can copy it without opening the thread. */
  app.get("/threads/:id/code", (c) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can read a sign-in code.");
    const rows = db.all<{ subject: string; body_text: string }>(
      `SELECT m.subject, m.body_text FROM messages m JOIN accounts a ON a.id = m.account_id
       WHERE m.thread_id = ? AND a.user_id = ? AND m.outgoing = 0 AND m.signals LIKE '%"kind":"code"%'
       ORDER BY m.sent_at DESC LIMIT 3`,
      c.req.param("id"),
      c.get("user").id,
    );
    const code = rows.map((m) => extractCode(m.subject, m.body_text)).find(Boolean) ?? null;
    if (!code) throw new HttpError(404, "No code in that conversation");
    c.header("Cache-Control", "no-store");
    return c.json({ code });
  });

  app.post("/triage", async (c) => {
    const { kind, ...input } = triageBody.parse(await c.req.json());
    const res = await ctx.commands.execute(c.get("actor"), triageCommandName(kind), input);
    return c.json({ ...(res.status === "done" ? (res.result as object) : {}), activityId: res.status === "done" ? res.activityId : null });
  });

  app.post("/undo", async (c) => {
    const { undoToken } = z.object({ undoToken: z.string() }).parse(await c.req.json());
    const ids = triage.revert(c.get("user").id, undoToken);
    ctx.commands.markUndoneByToken(c.get("user").id, undoToken);
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
    ctx.commands.record(c.get("actor"), "mail.zero", `Got to zero: marked ${ids.length} conversations done`, {
      threadIds: ids,
      undoToken: result.undoToken,
      inverse: { command: "triage.inbox", input: { threadIds: ids } },
    });
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
    const result = await unsubscribe(ctx, user.id, c.req.param("id"));
    ctx.commands.record({ kind: "human", user }, "mail.unsubscribe", `Unsubscribed from "${result.subject}"`, {
      threadIds: [c.req.param("id")],
      undoToken: result.undoToken,
    });
    return c.json({ method: result.method, url: result.url, undoToken: result.undoToken });
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
      firstSyncedAt: a.first_synced_at,
      identities: listIdentities(db, a.id),
    }));
    const splits = db
      .all<SplitRow>("SELECT * FROM splits WHERE user_id = ? ORDER BY position", user.id)
      .map((s) => ({ id: s.id, name: s.name, query: s.query, builtin: Boolean(s.builtin) }));
    const labels = db.all<{ name: string }>(
      `SELECT DISTINCT l.name FROM labels l JOIN accounts a ON a.id = l.account_id WHERE a.user_id = ? AND l.kind = 'user' ORDER BY l.name`,
      user.id,
    );
    // The person's preferences only: internal state (agents, models, Autopilot) has its own endpoints, and one
    // bad value must not take the whole dashboard down.
    const settings = Object.fromEntries(
      db
        .all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE user_id = ? AND key NOT LIKE 'secret:%' AND key NOT LIKE '%:%'", user.id)
        .filter((r) => !INTERNAL_SETTINGS.has(r.key))
        .flatMap((r) => {
          try {
            return [[r.key, JSON.parse(r.value)]];
          } catch {
            return [];
          }
        }),
    );
    settings.assistant = assistantSetting(ctx, user.id);
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
        demo: ctx.config.demo,
        sourceUrl: ctx.config.sourceUrl,
        cli: ctx.config.mode === "local" ? localCli() : null,
      },
    });
  });

  return app;
}

/**
 * How to run this install's CLI and stdio MCP bridge from another program (Claude Desktop, Cursor):
 * absolute paths, so it works whatever that program's PATH is. Local mode only.
 */
function localCli(): { command: string; args: string[] } | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "cli.js"), join(here, "../dist/cli.js"), join(here, "../../dist/cli.js"), join(here, "../cli.ts")]) {
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  return null;
}

export function emitThreads(ctx: AppContext, userId: string, threadIds: string[]) {
  if (threadIds.length === 0) return;
  ctx.events.emitToUser(userId, { type: "threads", accountId: "", threadIds });
}
