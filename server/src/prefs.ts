import { HttpError } from "./auth/users.ts";
import type { AppContext } from "./context.ts";
import { newId } from "./lib/crypto.ts";
import { sanitizeOutgoingHtml } from "./lib/sanitize.ts";
import { compile } from "./mail/query.ts";

/** Splits and snippets, shared by the dashboard routes and agent commands. */

export interface SplitView {
  id: string;
  name: string;
  query: string;
  builtin: boolean;
  /** Not shown as a tab. */
  hidden: boolean;
  /** Shown only while it holds something. */
  hideWhenEmpty: boolean;
  /** Where it sits in the tab strip, from 0. */
  position: number;
}

interface SplitDbRow {
  id: string;
  name: string;
  query: string;
  builtin: number;
  hidden: number;
  hide_when_empty: number;
}

const shapeSplit = (s: SplitDbRow, position: number): SplitView => ({
  id: s.id,
  name: s.name,
  query: s.query,
  builtin: Boolean(s.builtin),
  hidden: Boolean(s.hidden),
  hideWhenEmpty: Boolean(s.hide_when_empty),
  position,
});

export function listSplits(ctx: AppContext, userId: string): SplitView[] {
  return ctx.db
    .all<SplitDbRow>("SELECT id, name, query, builtin, hidden, hide_when_empty FROM splits WHERE user_id = ? ORDER BY position, rowid", userId)
    .map(shapeSplit);
}

/** Number the tabs 0, 1, 2 ... in the order given. */
function renumber(ctx: AppContext, ids: string[]) {
  ids.forEach((id, i) => ctx.db.run("UPDATE splits SET position = ? WHERE id = ?", i, id));
}

export function createSplit(ctx: AppContext, userId: string, name: string, query: string, opts: { hideWhenEmpty?: boolean; hidden?: boolean; position?: number } = {}): SplitView {
  if (compile(query).where === "1") throw new HttpError(400, "That search doesn't match anything specific");
  const id = newId("spl");
  ctx.db.tx(() => {
    ctx.db.run(
      "INSERT INTO splits (id, user_id, name, query, position, builtin, hidden, hide_when_empty) VALUES (?,?,?,?,?,0,?,?)",
      id, userId, name, query, 1_000_000, opts.hidden ? 1 : 0, opts.hideWhenEmpty ? 1 : 0,
    );
    const ids = listSplits(ctx, userId).map((s) => s.id).filter((x) => x !== id);
    ids.splice(opts.position === undefined ? ids.length : Math.min(Math.max(opts.position, 0), ids.length), 0, id);
    renumber(ctx, ids);
  });
  return listSplits(ctx, userId).find((s) => s.id === id)!;
}

/**
 * Change a tab. Every tab can be renamed, hidden, made to hide while empty and moved; only a custom tab has a search of its own to
 * change. Returns the tab as it was and as it is now.
 */
export function updateSplit(
  ctx: AppContext,
  userId: string,
  id: string,
  change: { name?: string; query?: string; hidden?: boolean; hideWhenEmpty?: boolean; position?: number },
): { before: SplitView; split: SplitView } {
  const before = listSplits(ctx, userId).find((s) => s.id === id);
  if (!before) throw new HttpError(404, "Split not found");
  if (change.query !== undefined && change.query !== before.query) {
    if (before.builtin) throw new HttpError(400, "A built-in tab keeps its search. You can rename it, hide it or move it.");
    if (compile(change.query).where === "1") throw new HttpError(400, "That search doesn't match anything specific");
  }
  ctx.db.tx(() => {
    ctx.db.run(
      "UPDATE splits SET name = ?, query = ?, hidden = ?, hide_when_empty = ? WHERE id = ?",
      change.name ?? before.name,
      change.query ?? before.query,
      (change.hidden ?? before.hidden) ? 1 : 0,
      (change.hideWhenEmpty ?? before.hideWhenEmpty) ? 1 : 0,
      id,
    );
    if (change.position !== undefined) {
      const ids = listSplits(ctx, userId).map((s) => s.id).filter((x) => x !== id);
      ids.splice(Math.min(Math.max(change.position, 0), ids.length), 0, id);
      renumber(ctx, ids);
    }
  });
  return { before, split: listSplits(ctx, userId).find((s) => s.id === id)! };
}

/** Remove a custom tab. Returns it as it was, so it can be put back. */
export function deleteSplit(ctx: AppContext, userId: string, id: string): SplitView {
  const s = listSplits(ctx, userId).find((x) => x.id === id);
  if (!s) throw new HttpError(404, "Split not found");
  if (s.builtin) throw new HttpError(400, "A built-in tab can't be removed. You can hide it instead.");
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM splits WHERE id = ?", id);
    renumber(ctx, listSplits(ctx, userId).map((x) => x.id));
  });
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
