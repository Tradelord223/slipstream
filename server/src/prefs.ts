import { HttpError } from "./auth/users.ts";
import type { AppContext } from "./context.ts";
import { newId } from "./lib/crypto.ts";
import { sanitizeOutgoingHtml } from "./lib/sanitize.ts";
import { compile } from "./mail/query.ts";

/** Splits and snippets, shared by the dashboard routes and agent commands. */

export function listSplits(ctx: AppContext, userId: string) {
  return ctx.db
    .all<{ id: string; name: string; query: string; builtin: number }>("SELECT id, name, query, builtin FROM splits WHERE user_id = ? ORDER BY position", userId)
    .map((s) => ({ id: s.id, name: s.name, query: s.query, builtin: Boolean(s.builtin) }));
}

export function createSplit(ctx: AppContext, userId: string, name: string, query: string) {
  if (compile(query).where === "1") throw new HttpError(400, "That search doesn't match anything specific");
  const position = (ctx.db.get<{ p: number }>("SELECT coalesce(max(position), -1) AS p FROM splits WHERE user_id = ?", userId)?.p ?? -1) + 1;
  const id = newId("spl");
  ctx.db.run("INSERT INTO splits (id, user_id, name, query, position, builtin) VALUES (?,?,?,?,?,0)", id, userId, name, query, position);
  return { id, name, query, builtin: false };
}

export function deleteSplit(ctx: AppContext, userId: string, id: string) {
  const s = ctx.db.get<{ name: string; query: string }>("SELECT name, query FROM splits WHERE id = ? AND user_id = ? AND builtin = 0", id, userId);
  if (!s) throw new HttpError(404, "Split not found");
  ctx.db.run("DELETE FROM splits WHERE id = ?", id);
  return s;
}

export function listSnippets(ctx: AppContext, userId: string) {
  const ws = ctx.users.workspaceOf(userId);
  return ctx.db
    .all<{ id: string; user_id: string; workspace_id: string | null; name: string; subject: string | null; body_html: string; use_count: number; author: string }>(
      `SELECT s.*, u.name AS author FROM snippets s JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ? OR (s.workspace_id IS NOT NULL AND s.workspace_id = ?)
       ORDER BY s.use_count DESC, s.name`,
      userId,
      ws?.id ?? "",
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      subject: s.subject,
      bodyHtml: s.body_html,
      shared: Boolean(s.workspace_id),
      mine: s.user_id === userId,
      author: s.author,
      useCount: s.use_count,
    }));
}

export function createSnippet(ctx: AppContext, userId: string, body: { name: string; subject?: string | null; bodyHtml: string; shared: boolean }) {
  const ws = body.shared ? ctx.users.workspaceOf(userId) : null;
  if (body.shared && !ws) throw new HttpError(400, "Join a team to share snippets");
  const id = newId("snp");
  ctx.db.run(
    "INSERT INTO snippets (id, user_id, workspace_id, name, subject, body_html, updated_at) VALUES (?,?,?,?,?,?,?)",
    id, userId, ws?.id ?? null, body.name, body.subject ?? null, sanitizeOutgoingHtml(body.bodyHtml), Date.now(),
  );
  if (ws) ctx.events.emitToWorkspace(ws.id, { type: "team", workspaceId: ws.id, sharedThreadId: "" });
  return { id };
}
