import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { addComment, shareThread } from "../team.ts";
import { newId } from "../lib/crypto.ts";

/**
 * Teams. Mail accounts stay private to each person; sharing a conversation takes a snapshot
 * that teammates can read, comment on and own. Re-sharing refreshes the snapshot.
 */
export function teamRoutes(ctx: AppContext) {
  const { db, users, events, config } = ctx;
  const app = new Hono<Env>();

  const requireWorkspace = (userId: string) => {
    const ws = users.workspaceOf(userId);
    if (!ws) throw new HttpError(400, config.mode === "local" ? "Teams need a Slipstream server. See the self-hosting guide." : "You're not on a team yet");
    return ws;
  };
  const sharedIn = (wsId: string, id: string) => {
    const s = db.get<{ id: string; source_thread_id: string | null; shared_by: string }>(
      "SELECT id, source_thread_id, shared_by FROM shared_threads WHERE id = ? AND workspace_id = ?",
      id,
      wsId,
    );
    if (!s) throw new HttpError(404, "Shared conversation not found");
    return s;
  };

  app.get("/team", (c) => {
    const user = c.get("user");
    const ws = users.workspaceOf(user.id);
    if (!ws) return c.json({ workspace: null, members: [], invites: [] });
    const members = db.all<{ id: string; name: string; email: string; role: string }>(
      `SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`,
      ws.id,
    );
    const invites =
      ws.role === "owner"
        ? db.all<{ email: string | null; expires_at: number }>(
            "SELECT email, expires_at FROM invites WHERE workspace_id = ? AND accepted_at IS NULL AND expires_at > ?",
            ws.id,
            Date.now(),
          )
        : [];
    return c.json({ workspace: ws, members, invites: invites.map((i) => ({ email: i.email, expiresAt: i.expires_at })) });
  });

  app.post("/team/invites", async (c) => {
    const user = c.get("user");
    const ws = requireWorkspace(user.id);
    const { email } = z.object({ email: z.email().optional() }).parse(await c.req.json().catch(() => ({})));
    const token = users.createInvite(ws.id, user.id, email ?? null);
    return c.json({ url: `${config.publicUrl}/join?invite=${token}`, expiresInDays: 14 });
  });

  app.delete("/team/members/:id", (c) => {
    const user = c.get("user");
    const ws = requireWorkspace(user.id);
    if (ws.role !== "owner") throw new HttpError(403, "Only the team owner can remove people");
    if (c.req.param("id") === user.id) throw new HttpError(400, "Owners can't remove themselves");
    db.run("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?", ws.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/threads/:id/share", (c) => c.json({ id: shareThread(ctx, c.get("user").id, c.req.param("id")).id }));

  app.get("/shared", (c) => {
    const user = c.get("user");
    const ws = users.workspaceOf(user.id);
    if (!ws) return c.json({ shared: [] });
    const status = c.req.query("status") === "resolved" ? "resolved" : "open";
    const rows = db.all<{
      id: string; subject: string; status: string; shared_by_name: string; assignee_id: string | null; assignee_name: string | null;
      updated_at: number; comment_count: number; last_comment: string | null;
    }>(
      `SELECT s.id, s.subject, s.status, u.name AS shared_by_name, s.assignee_id, a.name AS assignee_name, s.updated_at,
         (SELECT count(*) FROM comments c WHERE c.shared_thread_id = s.id) AS comment_count,
         (SELECT body FROM comments c WHERE c.shared_thread_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_comment
       FROM shared_threads s JOIN users u ON u.id = s.shared_by LEFT JOIN users a ON a.id = s.assignee_id
       WHERE s.workspace_id = ? AND s.status = ? ORDER BY s.updated_at DESC LIMIT 200`,
      ws.id,
      status,
    );
    return c.json({
      shared: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        sharedBy: r.shared_by_name,
        assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name } : null,
        updatedAt: r.updated_at,
        commentCount: r.comment_count,
        lastComment: r.last_comment,
      })),
    });
  });

  app.get("/shared/:id", (c) => {
    const user = c.get("user");
    const ws = requireWorkspace(user.id);
    sharedIn(ws.id, c.req.param("id"));
    const s = db.get<{ id: string; subject: string; snapshot: string; status: string; assignee_id: string | null; shared_by: string; source_thread_id: string | null; created_at: number }>(
      "SELECT * FROM shared_threads WHERE id = ?",
      c.req.param("id"),
    )!;
    const comments = db.all<{ id: string; user_id: string; name: string; body: string; created_at: number; agent_name: string | null }>(
      `SELECT c.id, c.user_id, u.name, c.body, c.created_at, c.agent_name FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.shared_thread_id = ? ORDER BY c.created_at`,
      s.id,
    );
    return c.json({
      id: s.id,
      subject: s.subject,
      status: s.status,
      assigneeId: s.assignee_id,
      sharedBy: users.get(s.shared_by),
      // The person who shared it can jump back to their own copy.
      ownThreadId: s.shared_by === user.id ? s.source_thread_id : null,
      messages: JSON.parse(s.snapshot),
      comments: comments.map((x) => ({ id: x.id, author: { id: x.user_id, name: x.name }, agentName: x.agent_name, body: x.body, createdAt: x.created_at })),
    });
  });

  app.post("/shared/:id/comments", async (c) => {
    const { body } = z.object({ body: z.string().trim().min(1).max(10_000) }).parse(await c.req.json());
    const { subject: _subject, ...comment } = addComment(ctx, { kind: "human", user: c.get("user") }, c.req.param("id"), body);
    return c.json(comment);
  });

  app.patch("/shared/:id", async (c) => {
    const user = c.get("user");
    const ws = requireWorkspace(user.id);
    const s = sharedIn(ws.id, c.req.param("id"));
    const body = z
      .object({ assigneeId: z.string().nullable().optional(), status: z.enum(["open", "resolved"]).optional() })
      .parse(await c.req.json());
    if (body.assigneeId && !db.get("SELECT 1 AS x FROM memberships WHERE workspace_id = ? AND user_id = ?", ws.id, body.assigneeId))
      throw new HttpError(400, "That person isn't on your team");
    if (body.assigneeId !== undefined) db.run("UPDATE shared_threads SET assignee_id = ? WHERE id = ?", body.assigneeId, s.id);
    if (body.status) db.run("UPDATE shared_threads SET status = ? WHERE id = ?", body.status, s.id);
    db.run("UPDATE shared_threads SET updated_at = ? WHERE id = ?", Date.now(), s.id);
    events.emitToWorkspace(ws.id, { type: "team", workspaceId: ws.id, sharedThreadId: s.id });
    return c.json({ ok: true });
  });

  return app;
}
