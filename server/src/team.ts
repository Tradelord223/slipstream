import { HttpError } from "./auth/users.ts";
import type { Actor } from "./commands/registry.ts";
import type { AppContext } from "./context.ts";
import { newId } from "./lib/crypto.ts";
import { maskCodes } from "./mail/signals.ts";

/** Team sharing and comments, shared by the dashboard routes and agent commands. */

export function requireWorkspace(ctx: AppContext, userId: string) {
  const ws = ctx.users.workspaceOf(userId);
  if (!ws) throw new HttpError(400, ctx.config.mode === "local" ? "Teams need a Slipstream server. See the self-hosting guide." : "You're not on a team yet");
  return ws;
}

export function sharedIn(ctx: AppContext, workspaceId: string, id: string) {
  const s = ctx.db.get<{ id: string; source_thread_id: string | null; shared_by: string; subject: string }>(
    "SELECT id, source_thread_id, shared_by, subject FROM shared_threads WHERE id = ? AND workspace_id = ?",
    id,
    workspaceId,
  );
  if (!s) throw new HttpError(404, "Shared conversation not found");
  return s;
}

/** Share (or re-share, refreshing the snapshot) one of the user's conversations with their team. */
export function shareThread(ctx: AppContext, userId: string, threadId: string): { id: string; subject: string } {
  const { db, events } = ctx;
  const ws = requireWorkspace(ctx, userId);
  const thread = db.get<{ id: string; subject: string }>(
    "SELECT t.id, t.subject FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND a.user_id = ?",
    threadId,
    userId,
  );
  if (!thread) throw new HttpError(404, "Conversation not found");
  const messages = db.all<{ from_name: string; from_email: string; to_json: string; cc_json: string; sent_at: number; body_text: string; body_html: string | null; subject: string }>(
    "SELECT from_name, from_email, to_json, cc_json, sent_at, body_text, body_html, subject FROM messages WHERE thread_id = ? ORDER BY sent_at",
    threadId,
  );
  const snapshot = JSON.stringify(
    messages.map((m) => ({
      from: { name: m.from_name, email: m.from_email },
      to: JSON.parse(m.to_json),
      cc: JSON.parse(m.cc_json),
      sentAt: m.sent_at,
      // A teammate never needs your sign-in code.
      ...maskCodes({ subject: m.subject, text: m.body_text, html: m.body_html }),
    })),
  );
  const subject = maskCodes({ subject: thread.subject }).subject;
  const now = Date.now();
  const existing = db.get<{ id: string }>("SELECT id FROM shared_threads WHERE source_thread_id = ? AND workspace_id = ?", threadId, ws.id);
  const id = existing?.id ?? newId("shr");
  if (existing) db.run("UPDATE shared_threads SET snapshot = ?, subject = ?, updated_at = ? WHERE id = ?", snapshot, subject, now, id);
  else
    db.run(
      `INSERT INTO shared_threads (id, workspace_id, shared_by, source_thread_id, subject, snapshot, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, ws.id, userId, threadId, subject, snapshot, now, now,
    );
  events.emitToWorkspace(ws.id, { type: "team", workspaceId: ws.id, sharedThreadId: id });
  return { id, subject };
}

export function addComment(ctx: AppContext, actor: Actor, sharedId: string, body: string) {
  const { db, events } = ctx;
  const ws = requireWorkspace(ctx, actor.user.id);
  const s = sharedIn(ctx, ws.id, sharedId);
  const id = newId("cmt");
  const now = Date.now();
  const agentName = actor.kind === "agent" ? actor.agent.name : null;
  db.run(
    "INSERT INTO comments (id, shared_thread_id, user_id, body, created_at, agent_name) VALUES (?,?,?,?,?,?)",
    id, s.id, actor.user.id, body, now, agentName,
  );
  db.run("UPDATE shared_threads SET updated_at = ? WHERE id = ?", now, s.id);
  events.emitToWorkspace(ws.id, { type: "team", workspaceId: ws.id, sharedThreadId: s.id });
  return { id, author: { id: actor.user.id, name: actor.user.name }, agentName, body, createdAt: now, subject: s.subject };
}
