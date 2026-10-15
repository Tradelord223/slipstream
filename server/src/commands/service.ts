import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";
import { newId } from "../lib/crypto.ts";
import { actorName, type Actor, type Command, type CommandOutcome } from "./registry.ts";

export type ExecuteResult =
  | { status: "done"; result: unknown; activityId: string | null }
  | { status: "pending_approval"; approvalId: string; reason: string };

interface ActivityRow {
  id: string;
  agent_id: string | null;
  actor_name: string;
  command: string;
  summary: string;
  thread_ids: string;
  status: string;
  undo_token: string | null;
  inverse: string | null;
  approval_id: string | null;
  error: string | null;
  created_at: number;
}

interface ApprovalRow {
  id: string;
  user_id: string;
  agent_id: string;
  command: string;
  input: string;
  preview: string;
  reason: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  decided_at: number | null;
}

/**
 * Runs commands for people and agents: validates input, enforces agent scopes, routes risky agent
 * actions to the Review queue, and records who did what so it can be seen and undone.
 */
export class Commands {
  private byName = new Map<string, Command>();
  private ctx!: AppContext;

  constructor(commands: Command[]) {
    for (const c of commands) this.byName.set(c.name, c);
  }

  /** The context is built after the registry; bind it once at boot. */
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }

  list(): Command[] {
    return [...this.byName.values()];
  }

  get(name: string): Command {
    const c = this.byName.get(name);
    if (!c) throw new HttpError(404, `Unknown command "${name}"`);
    return c;
  }

  /** JSON description of every command, for agents, the CLI and OpenAPI. */
  describe() {
    return this.list().map((c) => ({
      name: c.name,
      title: c.title,
      description: c.description,
      scope: c.scope,
      readOnly: Boolean(c.readOnly),
      input: z.toJSONSchema(c.input, { io: "input" }),
    }));
  }

  async execute(actor: Actor, name: string, rawInput: unknown, opts: { approvalId?: string } = {}): Promise<ExecuteResult> {
    const cmd = this.get(name);
    if (actor.kind === "agent" && !actor.agent.scopes.includes(cmd.scope))
      throw new HttpError(403, `This agent doesn't have the "${cmd.scope}" scope needed for ${cmd.name}.`);
    const input = cmd.input.parse(rawInput ?? {});

    if (actor.kind === "agent" && !opts.approvalId && cmd.approval) {
      const reason = cmd.approval(this.ctx, actor, input);
      if (reason) return this.requestApproval(actor, cmd, input, reason);
    }

    const outcome = await cmd.run(this.ctx, actor, input);
    if (cmd.readOnly) return { status: "done", result: outcome.result, activityId: null };
    const activityId = this.writeActivity(actor, cmd.name, outcome, opts.approvalId);
    return { status: "done", result: outcome.result, activityId };
  }

  /** Record an action taken outside the registry (e.g. the dashboard's own send flow). */
  record(actor: Actor, command: string, summary: string, outcome: Partial<CommandOutcome>) {
    return this.writeActivity(actor, command, { result: null, summary, ...outcome });
  }

  private writeActivity(actor: Actor, command: string, outcome: CommandOutcome, approvalId?: string): string {
    const { db, events } = this.ctx;
    const summary = outcome.summary ?? command;
    const threadIds = JSON.stringify(outcome.threadIds ?? []);
    const inverse = outcome.inverse ? JSON.stringify(outcome.inverse) : null;
    let id: string;
    const pending = approvalId ? db.get<{ id: string }>("SELECT id FROM activity WHERE approval_id = ?", approvalId) : undefined;
    if (pending) {
      id = pending.id;
      db.run(
        "UPDATE activity SET status = 'done', summary = ?, thread_ids = ?, undo_token = ?, inverse = ?, created_at = ? WHERE id = ?",
        summary, threadIds, outcome.undoToken ?? null, inverse, Date.now(), id,
      );
    } else {
      id = newId("act");
      db.run(
        `INSERT INTO activity (id, user_id, agent_id, actor_name, command, summary, thread_ids, status, undo_token, inverse, approval_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, actor.user.id, actor.kind === "agent" ? actor.agent.id : null, actorName(actor), command, summary, threadIds, "done",
        outcome.undoToken ?? null, inverse, approvalId ?? null, Date.now(),
      );
    }
    events.emitToUser(actor.user.id, { type: "activity", activityId: id });
    return id;
  }

  private requestApproval(actor: Extract<Actor, { kind: "agent" }>, cmd: Command, input: unknown, reason: string): ExecuteResult {
    const { db, events } = this.ctx;
    const id = newId("apr");
    const preview = cmd.preview ? cmd.preview(this.ctx, actor, input) : JSON.stringify(input, null, 2);
    const now = Date.now();
    db.tx(() => {
      db.run(
        "INSERT INTO approvals (id, user_id, agent_id, command, input, preview, reason, created_at) VALUES (?,?,?,?,?,?,?,?)",
        id, actor.user.id, actor.agent.id, cmd.name, JSON.stringify(input), preview, reason, now,
      );
      db.run(
        `INSERT INTO activity (id, user_id, agent_id, actor_name, command, summary, status, approval_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        newId("act"), actor.user.id, actor.agent.id, actor.agent.name, cmd.name, `Asked to ${cmd.title.toLowerCase()}`, "pending", id, now,
      );
    });
    events.emitToUser(actor.user.id, { type: "approval", approvalId: id, status: "pending" });
    return { status: "pending_approval", approvalId: id, reason };
  }

  // ---- Review queue ----------------------------------------------------------

  approvals(userId: string, status: "pending" | "decided" = "pending") {
    const rows = this.ctx.db.all<ApprovalRow & { agent_name: string }>(
      `SELECT a.*, g.name AS agent_name FROM approvals a JOIN agents g ON g.id = a.agent_id
       WHERE a.user_id = ? AND ${status === "pending" ? "a.status = 'pending'" : "a.status != 'pending'"}
       ORDER BY a.created_at DESC LIMIT 200`,
      userId,
    );
    return rows.map((r) => ({
      id: r.id,
      agent: { id: r.agent_id, name: r.agent_name },
      command: r.command,
      title: this.byName.get(r.command)?.title ?? r.command,
      preview: r.preview,
      reason: r.reason,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    }));
  }

  async approve(userId: string, approvalId: string): Promise<ExecuteResult> {
    const { db, events, agents, users } = this.ctx;
    const row = db.get<ApprovalRow>("SELECT * FROM approvals WHERE id = ? AND user_id = ?", approvalId, userId);
    if (!row) throw new HttpError(404, "Request not found");
    // Claim it so two clicks (or two devices) can't run it twice.
    const claimed = db.run("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'", Date.now(), approvalId);
    if (claimed.changes === 0) throw new HttpError(409, "This request was already decided.");
    const agent = agents.get(userId, row.agent_id);
    const user = users.get(userId)!;
    try {
      if (!agent) throw new HttpError(410, "The agent that asked for this was removed.");
      const result = await this.execute({ kind: "agent", user, agent }, row.command, JSON.parse(row.input), { approvalId });
      db.run("UPDATE approvals SET result = ? WHERE id = ?", JSON.stringify(result), approvalId);
      events.emitToUser(userId, { type: "approval", approvalId, status: "approved" });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.run("UPDATE approvals SET status = 'failed', error = ? WHERE id = ?", message, approvalId);
      db.run("UPDATE activity SET status = 'failed', error = ? WHERE approval_id = ?", message, approvalId);
      events.emitToUser(userId, { type: "approval", approvalId, status: "failed" });
      throw err;
    }
  }

  reject(userId: string, approvalId: string) {
    const { db, events } = this.ctx;
    const res = db.run(
      "UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'",
      Date.now(),
      approvalId,
      userId,
    );
    if (res.changes === 0) throw new HttpError(409, "This request was already decided.");
    db.run("UPDATE activity SET status = 'rejected' WHERE approval_id = ?", approvalId);
    events.emitToUser(userId, { type: "approval", approvalId, status: "rejected" });
  }

  // ---- Activity and undo -----------------------------------------------------

  activity(userId: string, opts: { limit?: number; agentId?: string; threadId?: string } = {}) {
    const where = ["a.user_id = ?"];
    const params: (string | number)[] = [userId];
    if (opts.agentId) {
      where.push("a.agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts.threadId) {
      where.push("EXISTS (SELECT 1 FROM json_each(a.thread_ids) j WHERE j.value = ?)");
      params.push(opts.threadId);
    }
    return this.ctx.db
      .all<ActivityRow>(`SELECT a.* FROM activity a WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT ?`, ...params, Math.min(opts.limit ?? 100, 500))
      .map((r) => ({
        id: r.id,
        actor: r.agent_id ? { kind: "agent" as const, id: r.agent_id, name: r.actor_name } : { kind: "human" as const, name: r.actor_name },
        command: r.command,
        summary: r.summary,
        threadIds: JSON.parse(r.thread_ids) as string[],
        status: r.status,
        canUndo: r.status === "done" && Boolean(r.undo_token || r.inverse),
        approvalId: r.approval_id,
        error: r.error,
        createdAt: r.created_at,
      }));
  }

  /** Undo by activity id: precise within the triage window, otherwise by running the inverse command. */
  async undo(actor: Actor, activityId: string) {
    const { db, triage, events } = this.ctx;
    const row = db.get<ActivityRow>("SELECT * FROM activity WHERE id = ? AND user_id = ?", activityId, actor.user.id);
    if (!row) throw new HttpError(404, "Activity not found");
    if (row.status !== "done") throw new HttpError(409, "Only completed actions can be undone.");
    const original = this.byName.get(row.command);
    if (actor.kind === "agent" && original && !actor.agent.scopes.includes(original.scope))
      throw new HttpError(403, `Undoing ${row.command} needs the "${original.scope}" scope.`);

    let threadIds: string[] = [];
    if (row.undo_token) threadIds = triage.revert(actor.user.id, row.undo_token);
    if (threadIds.length === 0 && row.inverse) {
      const inv = JSON.parse(row.inverse) as { command: string; input: unknown };
      // The inverse runs as this actor but never needs approval: it restores what was.
      const cmd = this.get(inv.command);
      const outcome = await cmd.run(this.ctx, actor, cmd.input.parse(inv.input));
      threadIds = outcome.threadIds ?? [];
    } else if (threadIds.length === 0) {
      throw new HttpError(409, "This action can't be undone anymore.");
    }
    db.run("UPDATE activity SET status = 'undone' WHERE id = ?", row.id);
    this.writeActivity(actor, "undo", { result: null, summary: `Undid: ${row.summary}`, threadIds });
    if (threadIds.length) events.emitToUser(actor.user.id, { type: "threads", accountId: "", threadIds });
    return { threadIds };
  }

  /** Mark the activity carrying an undo token as undone (used by the dashboard's Z key). */
  markUndoneByToken(userId: string, undoToken: string) {
    this.ctx.db.run("UPDATE activity SET status = 'undone' WHERE user_id = ? AND undo_token = ? AND status = 'done'", userId, undoToken);
  }
}
