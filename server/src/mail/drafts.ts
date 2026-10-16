import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";
import { newId } from "../lib/crypto.ts";
import { sanitizeOutgoingHtml } from "../lib/sanitize.ts";
import { resolveFrom } from "./identities.ts";

/** Drafts, Undo Send and Send Later, shared by the dashboard and agents. */

const address = z.object({ name: z.string().max(200).default(""), email: z.string().trim().toLowerCase().max(320) });

export const draftInput = z.object({
  accountId: z.string(),
  threadId: z.string().nullable().optional(),
  replyToMessageId: z.string().nullable().optional(),
  to: z.array(address).max(500).default([]),
  cc: z.array(address).max(500).default([]),
  bcc: z.array(address).max(500).default([]),
  subject: z.string().max(998).default(""),
  bodyHtml: z.string().max(5_000_000).default(""),
  /** One of the account's send-as addresses. Absent keeps the draft's current choice (a new draft uses the account's own address). */
  fromEmail: z.string().trim().toLowerCase().max(320).nullable().optional(),
});
export type DraftInput = z.infer<typeof draftInput>;

export const sendOptions = z.object({
  /** Absent: send after the undo window. Present: Send Later. */
  sendAt: z.number().int().optional(),
  /** Skip the undo window. */
  instant: z.boolean().default(false),
  /** Remind me if nobody replies within N days. */
  followUpDays: z.number().int().min(1).max(365).optional(),
  /** Mark the conversation done once it's sent. */
  markDone: z.boolean().default(false),
});
export type SendOptions = z.infer<typeof sendOptions>;

export interface DraftRow {
  id: string;
  account_id: string;
  /** NULL: the account's own address. */
  from_email: string | null;
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

export function draftRow(ctx: AppContext, userId: string, id: string): DraftRow {
  const d = ctx.db.get<DraftRow>("SELECT * FROM drafts WHERE id = ? AND user_id = ?", id, userId);
  if (!d) throw new HttpError(404, "Draft not found");
  return d;
}

export function shapeDraft(ctx: AppContext, d: DraftRow) {
  return {
    id: d.id,
    accountId: d.account_id,
    fromEmail: d.from_email ?? ctx.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", d.account_id)!.email,
    threadId: d.thread_id,
    replyToMessageId: d.reply_to_message_id,
    to: JSON.parse(d.to_json) as { name: string; email: string }[],
    cc: JSON.parse(d.cc_json) as { name: string; email: string }[],
    bcc: JSON.parse(d.bcc_json) as { name: string; email: string }[],
    subject: d.subject,
    bodyHtml: d.body_html,
    sendAt: d.send_at,
    status: d.status,
    error: d.error,
    updatedAt: d.updated_at,
    attachments: ctx.db
      .all<{ id: string; filename: string; mime_type: string; size: number }>(
        "SELECT id, filename, mime_type, size FROM draft_attachments WHERE draft_id = ?",
        d.id,
      )
      .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size })),
  };
}

export function getDraft(ctx: AppContext, userId: string, id: string) {
  return shapeDraft(ctx, draftRow(ctx, userId, id));
}

export function listDrafts(ctx: AppContext, userId: string) {
  return ctx.db
    .all<DraftRow>(
      "SELECT * FROM drafts WHERE user_id = ? AND status != 'sent' ORDER BY coalesce(send_at, updated_at) DESC LIMIT 200",
      userId,
    )
    .map((d) => shapeDraft(ctx, d));
}

function assertAccount(ctx: AppContext, userId: string, accountId: string) {
  const acc = ctx.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ? AND user_id = ?", accountId, userId);
  if (!acc) throw new HttpError(400, "Unknown sending account");
  return acc;
}

/** What goes in drafts.from_email: NULL for the account's own address, else the identity's address. Throws when it isn't theirs. */
function storedFrom(ctx: AppContext, accountId: string, accountEmail: string, fromEmail: string | null | undefined): string | null {
  if (!fromEmail) return null;
  const sender = resolveFrom(ctx.db, accountId, fromEmail);
  return sender.email.toLowerCase() === accountEmail.toLowerCase() ? null : sender.email;
}

function assertThread(ctx: AppContext, userId: string, threadId: string | null | undefined) {
  if (!threadId) return;
  const ok = ctx.db.get("SELECT 1 AS x FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND a.user_id = ?", threadId, userId);
  if (!ok) throw new HttpError(404, "Conversation not found");
}

export function createDraft(ctx: AppContext, userId: string, body: DraftInput) {
  const account = assertAccount(ctx, userId, body.accountId);
  assertThread(ctx, userId, body.threadId);
  const from = storedFrom(ctx, body.accountId, account.email, body.fromEmail);
  const id = newId("drf");
  ctx.db.run(
    `INSERT INTO drafts (id, user_id, account_id, from_email, thread_id, reply_to_message_id, to_json, cc_json, bcc_json, subject, body_html, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, userId, body.accountId, from, body.threadId ?? null, body.replyToMessageId ?? null,
    JSON.stringify(body.to), JSON.stringify(body.cc), JSON.stringify(body.bcc), body.subject, body.bodyHtml, Date.now(),
  );
  ctx.events.emitToUser(userId, { type: "drafts", draftId: id, status: "draft" });
  return getDraft(ctx, userId, id);
}

export function updateDraft(ctx: AppContext, userId: string, id: string, body: DraftInput) {
  const d = draftRow(ctx, userId, id);
  if (d.status === "sending" || d.status === "sent") throw new HttpError(409, "This message was already sent");
  const account = assertAccount(ctx, userId, body.accountId);
  let from: string | null;
  if (body.fromEmail !== undefined) from = storedFrom(ctx, body.accountId, account.email, body.fromEmail);
  else if (body.accountId === d.account_id) from = d.from_email;
  else {
    // Moved to another account without choosing an address: keep the old one only if that account also has it.
    try {
      from = storedFrom(ctx, body.accountId, account.email, d.from_email);
    } catch {
      from = null;
    }
  }
  ctx.db.run(
    "UPDATE drafts SET account_id=?, from_email=?, to_json=?, cc_json=?, bcc_json=?, subject=?, body_html=?, updated_at=? WHERE id=?",
    body.accountId, from, JSON.stringify(body.to), JSON.stringify(body.cc), JSON.stringify(body.bcc), body.subject, body.bodyHtml, Date.now(), d.id,
  );
  return getDraft(ctx, userId, id);
}

export function deleteDraft(ctx: AppContext, userId: string, id: string) {
  const d = draftRow(ctx, userId, id);
  if (d.status === "sending" || d.status === "sent") throw new HttpError(409, "This message was already sent");
  ctx.db.run("DELETE FROM drafts WHERE id = ?", d.id);
}

/** Queue a draft to send. Returns when it will leave and, with markDone, the undo token for the triage. */
export function sendDraft(ctx: AppContext, userId: string, id: string, opts: SendOptions) {
  const d = draftRow(ctx, userId, id);
  if (d.status === "sending" || d.status === "sent") throw new HttpError(409, "This message was already sent");
  const recipients = JSON.parse(d.to_json).length + JSON.parse(d.cc_json).length + JSON.parse(d.bcc_json).length;
  if (recipients === 0) throw new HttpError(400, "Add at least one recipient");
  resolveFrom(ctx.db, d.account_id, d.from_email); // fail now, not after the undo window, if the address was removed
  const now = Date.now();
  const sendAt = opts.sendAt && opts.sendAt > now ? opts.sendAt : opts.instant ? now : now + ctx.config.undoSendSeconds * 1000;
  ctx.db.run(
    "UPDATE drafts SET status = 'scheduled', send_at = ?, follow_up_days = ?, body_html = ?, error = NULL, updated_at = ? WHERE id = ?",
    sendAt,
    opts.followUpDays ?? null,
    sanitizeOutgoingHtml(d.body_html),
    now,
    d.id,
  );
  let undoToken: string | null = null;
  if (opts.markDone && d.thread_id) {
    undoToken = ctx.triage.apply(userId, { kind: "done", threadIds: [d.thread_id] }).undoToken;
    ctx.events.emitToUser(userId, { type: "threads", accountId: d.account_id, threadIds: [d.thread_id] });
  }
  ctx.events.emitToUser(userId, { type: "drafts", draftId: d.id, status: "scheduled" });
  return { id: d.id, sendAt, undoToken };
}

/** Undo Send / cancel Send Later: back to an editable draft if it hasn't left yet. */
export function cancelSend(ctx: AppContext, userId: string, id: string) {
  const d = draftRow(ctx, userId, id);
  const res = ctx.db.run(
    "UPDATE drafts SET status = 'draft', send_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'",
    Date.now(),
    d.id,
  );
  if (res.changes === 0) throw new HttpError(409, "Too late — this message already left.");
  ctx.events.emitToUser(userId, { type: "drafts", draftId: d.id, status: "draft" });
  return getDraft(ctx, userId, id);
}

/** Who a draft goes to, for approval previews and the "external" policy. */
export function draftRecipients(ctx: AppContext, userId: string, id: string) {
  const d = draftRow(ctx, userId, id);
  const from = d.from_email ?? ctx.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", d.account_id)!.email;
  const all = [...JSON.parse(d.to_json), ...JSON.parse(d.cc_json), ...JSON.parse(d.bcc_json)] as { email: string }[];
  return { draft: d, from, emails: all.map((a) => a.email) };
}
