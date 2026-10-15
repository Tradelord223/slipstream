import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";
import { newId } from "../lib/crypto.ts";
import { compile } from "./query.ts";

/**
 * Labels as people see them: one label per name across all their accounts (Gmail labels, Outlook
 * categories and IMAP keywords underneath), nested with "/", with a color. Plus auto-label rules
 * that label new mail matching a search.
 */

export interface LabelSummary {
  name: string;
  color: string | null;
  parent: string | null;
  count: number;
  unread: number;
}

const userAccounts = "SELECT id FROM accounts WHERE user_id = ?";

export function parentOf(name: string): string | null {
  const i = name.lastIndexOf("/");
  return i > 0 ? name.slice(0, i) : null;
}

export function listLabels(ctx: AppContext, userId: string): LabelSummary[] {
  const rows = ctx.db.all<{ name: string; color: string | null; count: number; unread: number }>(
    `SELECT min(l.name) AS name, max(l.color) AS color,
       count(DISTINCT tl.thread_id) AS count,
       count(DISTINCT CASE WHEN t.unread_count > 0 AND t.in_trash = 0 AND t.in_spam = 0 THEN tl.thread_id END) AS unread
     FROM labels l
     LEFT JOIN thread_labels tl ON tl.label_id = l.id
     LEFT JOIN threads t ON t.id = tl.thread_id
     WHERE l.account_id IN (${userAccounts}) AND l.kind = 'user'
     GROUP BY lower(l.name) ORDER BY lower(l.name)`,
    userId,
  );
  return rows.map((r) => ({ ...r, parent: parentOf(r.name) }));
}

function labelRows(ctx: AppContext, userId: string, name: string) {
  return ctx.db.all<{ id: string; account_id: string; remote_id: string; name: string }>(
    `SELECT id, account_id, remote_id, name FROM labels WHERE account_id IN (${userAccounts}) AND lower(name) = lower(?)`,
    userId,
    name,
  );
}

const normalize = (name: string) =>
  name
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");

export function createLabel(ctx: AppContext, userId: string, rawName: string, color?: string | null) {
  const name = normalize(rawName);
  if (!name) throw new HttpError(400, "Give the label a name");
  if (labelRows(ctx, userId, name).length) throw new HttpError(409, `"${name}" already exists`);
  const accounts = ctx.db.all<{ id: string }>(`SELECT id FROM accounts WHERE user_id = ?`, userId);
  if (accounts.length === 0) throw new HttpError(400, "Connect an account first");
  ctx.db.tx(() => {
    for (const a of accounts)
      ctx.db.run("INSERT INTO labels (id, account_id, remote_id, name, kind, color) VALUES (?,?,?,?,'user',?)", newId("lbl"), a.id, `name:${name}`, name, color ?? null);
  });
  return listLabels(ctx, userId).find((l) => l.name.toLowerCase() === name.toLowerCase())!;
}

/** Rename (children follow: "Clients" → "Customers" also moves "Clients/Kettleby") and/or recolor. */
export function updateLabel(ctx: AppContext, userId: string, name: string, change: { newName?: string; color?: string | null }) {
  const rows = labelRows(ctx, userId, name);
  if (rows.length === 0) throw new HttpError(404, `No label called "${name}"`);
  const newName = change.newName !== undefined ? normalize(change.newName) : undefined;
  if (newName !== undefined && !newName) throw new HttpError(400, "Give the label a name");
  if (newName && newName.toLowerCase() !== name.toLowerCase() && labelRows(ctx, userId, newName).length)
    throw new HttpError(409, `"${newName}" already exists`);
  const now = Date.now();
  ctx.db.tx(() => {
    if (change.color !== undefined)
      ctx.db.run(`UPDATE labels SET color = ? WHERE account_id IN (${userAccounts}) AND lower(name) = lower(?)`, change.color, userId, name);
    if (newName && newName !== name) {
      const affected = ctx.db.all<{ id: string; account_id: string; remote_id: string; name: string }>(
        `SELECT id, account_id, remote_id, name FROM labels WHERE account_id IN (${userAccounts}) AND (lower(name) = lower(?) OR lower(name) LIKE lower(?) || '/%')`,
        userId,
        name,
        name,
      );
      for (const l of affected) {
        const renamed = newName + l.name.slice(name.length);
        ctx.db.run("UPDATE labels SET name = ?, remote_id = CASE WHEN remote_id LIKE 'name:%' THEN 'name:' || ? ELSE remote_id END WHERE id = ?", renamed, renamed, l.id);
        if (!l.remote_id.startsWith("name:")) queueLabelOp(ctx, l.account_id, { kind: "rename", label: { remoteId: l.remote_id, name: l.name }, newName: renamed }, now);
      }
      ctx.db.run("UPDATE label_rules SET label = ? WHERE user_id = ? AND lower(label) = lower(?)", newName, userId, name);
    }
  });
  return listLabels(ctx, userId).find((l) => l.name.toLowerCase() === (newName ?? name).toLowerCase())!;
}

export function deleteLabel(ctx: AppContext, userId: string, name: string) {
  const rows = labelRows(ctx, userId, name);
  if (rows.length === 0) throw new HttpError(404, `No label called "${name}"`);
  const touched = new Set<string>();
  ctx.db.tx(() => {
    for (const l of rows) {
      for (const t of ctx.db.all<{ thread_id: string }>("SELECT thread_id FROM thread_labels WHERE label_id = ?", l.id)) touched.add(t.thread_id);
      // Keep per-message label sets consistent, or the next recompute would point at a missing label.
      ctx.db.run(
        `UPDATE messages SET label_ids = (SELECT json_group_array(value) FROM json_each(messages.label_ids) WHERE value != ?)
         WHERE account_id = ? AND label_ids LIKE '%' || ? || '%'`,
        l.id,
        l.account_id,
        l.id,
      );
      ctx.db.run("DELETE FROM labels WHERE id = ?", l.id);
      if (!l.remote_id.startsWith("name:")) queueLabelOp(ctx, l.account_id, { kind: "delete", label: { remoteId: l.remote_id, name: l.name } }, Date.now());
    }
    ctx.db.run("DELETE FROM label_rules WHERE user_id = ? AND lower(label) = lower(?)", userId, name);
  });
  if (touched.size) ctx.events.emitToUser(userId, { type: "threads", accountId: "", threadIds: [...touched] });
  return { name, threads: touched.size };
}

function queueLabelOp(ctx: AppContext, accountId: string, labelOp: object, now: number) {
  ctx.db.run(
    "INSERT INTO pending_actions (account_id, kind, payload, run_after, created_at) VALUES (?,?,?,?,?)",
    accountId,
    "labelAdmin",
    JSON.stringify({ labelOp }),
    now,
    now,
  );
}

// ---- Auto-label rules ----------------------------------------------------------

interface RuleRow {
  id: string;
  user_id: string;
  label: string;
  query: string;
  enabled: number;
  last_checked_at: number;
  created_at: number;
}

const shapeRule = (r: RuleRow) => ({ id: r.id, label: r.label, query: r.query, enabled: Boolean(r.enabled), createdAt: r.created_at });

export function listRules(ctx: AppContext, userId: string) {
  return ctx.db.all<RuleRow>("SELECT * FROM label_rules WHERE user_id = ? ORDER BY created_at", userId).map(shapeRule);
}

function assertQuery(query: string) {
  if (compile(query).where === "1") throw new HttpError(400, "That search doesn't match anything specific");
}

export function createRule(ctx: AppContext, userId: string, label: string, query: string) {
  assertQuery(query);
  const name = normalize(label);
  if (!labelRows(ctx, userId, name).length) createLabel(ctx, userId, name);
  const id = newId("lrl");
  const now = Date.now();
  ctx.db.run("INSERT INTO label_rules (id, user_id, label, query, enabled, last_checked_at, created_at) VALUES (?,?,?,?,1,?,?)", id, userId, name, query, now, now);
  return shapeRule(ctx.db.get<RuleRow>("SELECT * FROM label_rules WHERE id = ?", id)!);
}

export function updateRule(ctx: AppContext, userId: string, id: string, change: { label?: string; query?: string; enabled?: boolean }) {
  const r = ctx.db.get<RuleRow>("SELECT * FROM label_rules WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw new HttpError(404, "Rule not found");
  if (change.query) assertQuery(change.query);
  ctx.db.run(
    "UPDATE label_rules SET label = coalesce(?, label), query = coalesce(?, query), enabled = coalesce(?, enabled) WHERE id = ?",
    change.label ? normalize(change.label) : null,
    change.query ?? null,
    change.enabled === undefined ? null : change.enabled ? 1 : 0,
    id,
  );
  return shapeRule(ctx.db.get<RuleRow>("SELECT * FROM label_rules WHERE id = ?", id)!);
}

export function deleteRule(ctx: AppContext, userId: string, id: string) {
  const r = ctx.db.get<RuleRow>("SELECT * FROM label_rules WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw new HttpError(404, "Rule not found");
  ctx.db.run("DELETE FROM label_rules WHERE id = ?", id);
  return shapeRule(r);
}

/** Threads a rule would label: matching, not already labelled, optionally only those with mail since `since`. */
export function ruleMatches(ctx: AppContext, rule: { user_id: string; label: string; query: string }, since: number | null, limit = 5000): string[] {
  const c = compile(rule.query);
  return ctx.db
    .all<{ id: string }>(
      `SELECT t.id FROM threads t WHERE t.account_id IN (${userAccounts}) AND (${c.where})
       AND NOT EXISTS (SELECT 1 FROM thread_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.thread_id = t.id AND lower(l.name) = lower(?))
       ${since !== null ? "AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.created_at > ?)" : ""}
       ORDER BY t.sort_at DESC LIMIT ?`,
      rule.user_id,
      ...c.params,
      rule.label,
      ...(since !== null ? [since] : []),
      limit,
    )
    .map((r) => r.id);
}

/**
 * Apply rules to mail that arrived since each rule last looked. Only new mail: a label someone removes
 * by hand stays removed.
 */
export function runRules(ctx: AppContext, now = Date.now()) {
  const rules = ctx.db.all<RuleRow>("SELECT * FROM label_rules WHERE enabled = 1");
  for (const r of rules) {
    const ids = ruleMatches(ctx, r, r.last_checked_at);
    ctx.db.run("UPDATE label_rules SET last_checked_at = ? WHERE id = ?", now, r.id);
    if (ids.length === 0) continue;
    const res = ctx.triage.apply(r.user_id, { kind: "addLabel", threadIds: ids, label: r.label });
    const user = ctx.users.get(r.user_id);
    if (user)
      ctx.commands.record({ kind: "human", user }, "labelRules.apply", `Auto-labelled ${ids.length === 1 ? "1 conversation" : `${ids.length} conversations`} "${r.label}"`, {
        threadIds: res.threadIds,
        undoToken: res.undoToken,
        inverse: { command: "triage.unlabel", input: { threadIds: res.threadIds, label: r.label } },
      });
    ctx.events.emitToUser(r.user_id, { type: "threads", accountId: "", threadIds: res.threadIds });
  }
}
