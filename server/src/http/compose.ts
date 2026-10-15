import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { newId } from "../lib/crypto.ts";
import { sanitizeOutgoingHtml } from "../lib/sanitize.ts";

const address = z.object({ name: z.string().max(200).default(""), email: z.string().trim().toLowerCase().max(320) });

const draftBody = z.object({
  accountId: z.string(),
  threadId: z.string().nullable().optional(),
  replyToMessageId: z.string().nullable().optional(),
  to: z.array(address).max(500).default([]),
  cc: z.array(address).max(500).default([]),
  bcc: z.array(address).max(500).default([]),
  subject: z.string().max(998).default(""),
  bodyHtml: z.string().max(5_000_000).default(""),
});

const sendBody = z.object({
  /** Absent: send after the undo window. Present: Send Later. */
  sendAt: z.number().int().optional(),
  /** Skip the undo window. */
  instant: z.boolean().default(false),
  /** Remind me if nobody replies within N days. */
  followUpDays: z.number().int().min(1).max(365).optional(),
  /** Mark the conversation done once it's sent. */
  markDone: z.boolean().default(false),
});

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface DraftRow {
  id: string;
  account_id: string;
  thread_id: string | null;
  reply_to_message_id: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body_html: string;
  send_at: number | null;
  status: string;
  error: string | null;
  updated_at: number;
}

export function composeRoutes(ctx: AppContext) {
  const { db, store, config, triage, events } = ctx;
  const app = new Hono<Env>();

  const own = (userId: string, id: string) => {
    const d = db.get<DraftRow>("SELECT * FROM drafts WHERE id = ? AND user_id = ?", id, userId);
    if (!d) throw new HttpError(404, "Draft not found");
    return d;
  };
  const shape = (d: DraftRow) => ({
    id: d.id,
    accountId: d.account_id,
    threadId: d.thread_id,
    replyToMessageId: d.reply_to_message_id,
    to: JSON.parse(d.to_json),
    cc: JSON.parse(d.cc_json),
    bcc: JSON.parse(d.bcc_json),
    subject: d.subject,
    bodyHtml: d.body_html,
    sendAt: d.send_at,
    status: d.status,
    error: d.error,
    updatedAt: d.updated_at,
    attachments: db
      .all<{ id: string; filename: string; mime_type: string; size: number }>(
        "SELECT id, filename, mime_type, size FROM draft_attachments WHERE draft_id = ?",
        d.id,
      )
      .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size })),
  });

  const assertAccount = (userId: string, accountId: string) => {
    if (!db.get("SELECT 1 AS x FROM accounts WHERE id = ? AND user_id = ?", accountId, userId))
      throw new HttpError(400, "Unknown sending account");
  };

  app.get("/drafts", (c) => {
    const rows = db.all<DraftRow>(
      "SELECT * FROM drafts WHERE user_id = ? AND status != 'sent' ORDER BY coalesce(send_at, updated_at) DESC LIMIT 200",
      c.get("user").id,
    );
    return c.json({ drafts: rows.map(shape) });
  });

  app.get("/drafts/:id", (c) => c.json(shape(own(c.get("user").id, c.req.param("id")))));

  app.post("/drafts", async (c) => {
    const user = c.get("user");
    const body = draftBody.parse(await c.req.json());
    assertAccount(user.id, body.accountId);
    const id = newId("drf");
    db.run(
      `INSERT INTO drafts (id, user_id, account_id, thread_id, reply_to_message_id, to_json, cc_json, bcc_json, subject, body_html, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, user.id, body.accountId, body.threadId ?? null, body.replyToMessageId ?? null,
      JSON.stringify(body.to), JSON.stringify(body.cc), JSON.stringify(body.bcc), body.subject, body.bodyHtml, Date.now(),
    );
    return c.json(shape(own(user.id, id)));
  });

  app.put("/drafts/:id", async (c) => {
    const user = c.get("user");
    const d = own(user.id, c.req.param("id"));
    if (d.status === "sending" || d.status === "sent") throw new HttpError(409, "This message was already sent");
    const body = draftBody.parse(await c.req.json());
    assertAccount(user.id, body.accountId);
    db.run(
      `UPDATE drafts SET account_id=?, to_json=?, cc_json=?, bcc_json=?, subject=?, body_html=?, updated_at=? WHERE id=?`,
      body.accountId, JSON.stringify(body.to), JSON.stringify(body.cc), JSON.stringify(body.bcc), body.subject, body.bodyHtml, Date.now(), d.id,
    );
    return c.json(shape(own(user.id, d.id)));
  });

  app.delete("/drafts/:id", (c) => {
    const d = own(c.get("user").id, c.req.param("id"));
    if (d.status === "sending" || d.status === "sent") throw new HttpError(409, "This message was already sent");
    db.run("DELETE FROM drafts WHERE id = ?", d.id);
    return c.json({ ok: true });
  });

  app.post("/drafts/:id/send", async (c) => {
    const user = c.get("user");
    const d = own(user.id, c.req.param("id"));
    if (d.status === "sending" || d.status === "sent") throw new HttpError(409, "This message was already sent");
    const body = sendBody.parse(await c.req.json().catch(() => ({})));
    const to = JSON.parse(d.to_json) as unknown[];
    const cc = JSON.parse(d.cc_json) as unknown[];
    const bcc = JSON.parse(d.bcc_json) as unknown[];
    if (to.length + cc.length + bcc.length === 0) throw new HttpError(400, "Add at least one recipient");
    const now = Date.now();
    const sendAt = body.sendAt && body.sendAt > now ? body.sendAt : body.instant ? now : now + config.undoSendSeconds * 1000;
    db.run(
      "UPDATE drafts SET status = 'scheduled', send_at = ?, follow_up_days = ?, body_html = ?, error = NULL, updated_at = ? WHERE id = ?",
      sendAt,
      body.followUpDays ?? null,
      sanitizeOutgoingHtml(d.body_html),
      now,
      d.id,
    );
    let undoToken: string | null = null;
    if (body.markDone && d.thread_id) {
      undoToken = triage.apply(user.id, { kind: "done", threadIds: [d.thread_id] }).undoToken;
      events.emitToUser(user.id, { type: "threads", accountId: d.account_id, threadIds: [d.thread_id] });
    }
    events.emitToUser(user.id, { type: "drafts", draftId: d.id, status: "scheduled" });
    return c.json({ id: d.id, sendAt, undoToken });
  });

  /** Undo Send and cancelling a scheduled message: back to an editable draft, if it hasn't left yet. */
  app.post("/drafts/:id/cancel", (c) => {
    const user = c.get("user");
    const d = own(user.id, c.req.param("id"));
    const res = db.run(
      "UPDATE drafts SET status = 'draft', send_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'",
      Date.now(),
      d.id,
    );
    if (res.changes === 0) throw new HttpError(409, "Too late — this message already left.");
    events.emitToUser(user.id, { type: "drafts", draftId: d.id, status: "draft" });
    return c.json(shape(own(user.id, d.id)));
  });

  app.post("/drafts/:id/attachments", async (c) => {
    const user = c.get("user");
    const d = own(user.id, c.req.param("id"));
    const form = await c.req.formData();
    const added = [];
    for (const value of form.getAll("file")) {
      if (typeof value === "string") continue;
      if (value.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `${value.name} is over 25 MB`);
      const content = Buffer.from(await value.arrayBuffer());
      const id = newId("datt");
      db.run(
        "INSERT INTO draft_attachments (id, draft_id, filename, mime_type, size, blob_sha256) VALUES (?,?,?,?,?,?)",
        id,
        d.id,
        value.name.slice(0, 255) || "attachment",
        value.type || "application/octet-stream",
        content.length,
        store.saveBlob(content),
      );
      added.push(id);
    }
    return c.json(shape(own(user.id, d.id)));
  });

  app.delete("/drafts/:id/attachments/:att", (c) => {
    const d = own(c.get("user").id, c.req.param("id"));
    db.run("DELETE FROM draft_attachments WHERE id = ? AND draft_id = ?", c.req.param("att"), d.id);
    return c.json(shape(own(c.get("user").id, d.id)));
  });

  return app;
}
