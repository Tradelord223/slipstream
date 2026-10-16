import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";

/**
 * One-key unsubscribe from a List-Unsubscribe header. A mailto target gets an email sent for the
 * user (through the normal send queue); a web target comes back for the user to open.
 * The conversation is marked done either way.
 */
export async function unsubscribe(ctx: AppContext, userId: string, threadId: string) {
  const { db, triage, events } = ctx;
  const msg = db.get<{ list_unsubscribe: string; account_id: string }>(
    `SELECT m.list_unsubscribe, m.account_id FROM messages m JOIN accounts a ON a.id = m.account_id
     WHERE m.thread_id = ? AND a.user_id = ? AND m.list_unsubscribe IS NOT NULL ORDER BY m.sent_at DESC LIMIT 1`,
    threadId,
    userId,
  );
  if (!msg) throw new HttpError(404, "This sender didn't include an unsubscribe link.");
  const subject = db.get<{ subject: string }>("SELECT subject FROM threads WHERE id = ?", threadId)?.subject ?? "";
  const targets = [...msg.list_unsubscribe.matchAll(/<([^>]+)>|((?:https?|mailto):[^\s,]+)/g)].map((m) => (m[1] ?? m[2])!.trim());
  const web = targets.find((t) => /^https:\/\//i.test(t));
  const mailto = targets.find((t) => /^mailto:/i.test(t));
  const result = triage.apply(userId, { kind: "done", threadIds: [threadId] });
  events.emitToUser(userId, { type: "threads", accountId: "", threadIds: result.threadIds });
  if (mailto) {
    const url = new URL(mailto);
    const now = Date.now();
    db.run(
      `INSERT INTO drafts (id, user_id, account_id, from_email, to_json, subject, body_html, send_at, status, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      `drf_unsub_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      userId,
      msg.account_id,
      // Always the account's own address (NULL). The mailto target is written by the sender, so answering from
      // an alias picked out of its headers would tell the sender which of our addresses belong together.
      null,
      JSON.stringify([{ name: "", email: decodeURIComponent(url.pathname) }]),
      url.searchParams.get("subject") ?? "unsubscribe",
      `<p>${(url.searchParams.get("body") ?? "unsubscribe").replace(/[<>&]/g, "")}</p>`,
      now,
      "scheduled",
      now,
    );
    return { method: "email" as const, url: null, undoToken: result.undoToken, subject };
  }
  return { method: "web" as const, url: web ?? null, undoToken: result.undoToken, subject };
}
