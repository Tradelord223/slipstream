import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";
import { newId } from "../lib/crypto.ts";
import { CATEGORY_NAMES, isCategory, type Category } from "./classify.ts";
import { isPersonalMailDomain, registrableDomain } from "./logos.ts";

/**
 * A person's corrections to how mail is sorted: "mail from this address, domain or mailing list goes to that category".
 * They are rows of category_rules, and sorting reads them before anything else but the person's own replies and VIPs.
 */

export interface CategoryRule {
  id: string;
  pattern: string;
  category: Category;
  createdAt: number;
}

export type CorrectionScope = "sender" | "domain" | "list";

interface RuleRow {
  id: string;
  pattern: string;
  category: string;
  created_at: number;
}

const shape = (r: RuleRow): CategoryRule => ({ id: r.id, pattern: r.pattern, category: r.category as Category, createdAt: r.created_at });

export function listCategoryRules(ctx: AppContext, userId: string): CategoryRule[] {
  return ctx.db
    .all<RuleRow>("SELECT id, pattern, category, created_at FROM category_rules WHERE user_id = ? ORDER BY created_at DESC, id", userId)
    .filter((r) => isCategory(r.category))
    .map(shape);
}

/** An address, `@domain` or `list:id` in the form rules are stored in; anything else is an error the person can read. */
export function normalizePattern(raw: string): string {
  const p = raw.trim().toLowerCase();
  if (p.startsWith("list:")) {
    const id = p.slice(5).replace(/[<>\s]/g, "");
    if (!id) throw new HttpError(400, "Name the mailing list after list:");
    return `list:${id}`;
  }
  if (p.startsWith("@")) {
    const host = p.slice(1);
    const domain = registrableDomain(`x@${host}`);
    if (!domain) throw new HttpError(400, `"${host}" isn't a domain`);
    if (isPersonalMailDomain(domain)) throw new HttpError(400, `${domain} is shared by many people. Move one sender instead.`);
    return `@${domain}`;
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) return p;
  throw new HttpError(400, "Use an address (ana@shop.com), a domain (@shop.com) or a mailing list (list:news.shop.com)");
}

/** What a conversation's latest incoming message lets a person correct: its sender, the sender's domain, its mailing list. */
export function patternFor(ctx: AppContext, userId: string, threadId: string, scope: CorrectionScope): { pattern: string; label: string } {
  const m = ctx.db.get<{ from_name: string; from_email: string; sender_domain: string | null; list_id: string | null }>(
    `SELECT m.from_name, m.from_email, m.sender_domain, m.list_id FROM messages m JOIN threads t ON t.id = m.thread_id
     JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ? AND a.user_id = ? AND m.outgoing = 0 ORDER BY m.sent_at DESC LIMIT 1`,
    threadId,
    userId,
  );
  if (!m) throw new HttpError(404, "Conversation not found");
  if (scope === "sender") return { pattern: normalizePattern(m.from_email), label: m.from_name || m.from_email };
  if (scope === "list") {
    if (!m.list_id) throw new HttpError(400, "This mail didn't come from a mailing list");
    return { pattern: `list:${m.list_id}`, label: `the mailing list ${m.list_id}` };
  }
  if (!m.sender_domain) throw new HttpError(400, "This sender has no company domain");
  return { pattern: normalizePattern(`@${m.sender_domain}`), label: m.sender_domain };
}

/** Conversations with incoming mail that the pattern names, in this person's accounts. */
function threadsMatching(ctx: AppContext, userId: string, pattern: string): string[] {
  const [where, value] = pattern.startsWith("list:")
    ? ["m.list_id = ?", pattern.slice(5)]
    : pattern.startsWith("@")
      ? ["m.sender_domain = ?", pattern.slice(1)]
      : ["m.from_email = ?", pattern];
  return ctx.db
    .all<{ thread_id: string }>(
      `SELECT DISTINCT m.thread_id FROM messages m JOIN accounts a ON a.id = m.account_id
       WHERE a.user_id = ? AND m.outgoing = 0 AND ${where}`,
      userId,
      value,
    )
    .map((r) => r.thread_id);
}

/** Sort the conversations again and tell the open dashboard. Returns the ones whose category or reason changed. */
export function resortThreads(ctx: AppContext, userId: string, threadIds: string[]): string[] {
  const changed = ctx.store.recategorize(threadIds);
  for (let i = 0; i < changed.length; i += 200) ctx.events.emitToUser(userId, { type: "threads", accountId: "", threadIds: changed.slice(i, i + 200) });
  return changed;
}

/**
 * Send mail from a sender, domain or mailing list to a category from now on, and move what's already here at once.
 * `previous` is the correction this replaces, if there was one, so it can be undone.
 */
export function setCategoryRule(ctx: AppContext, userId: string, rawPattern: string, category: Category, by: { kind: "human" | "agent"; name: string }) {
  const pattern = normalizePattern(rawPattern);
  const previous = ctx.db.get<RuleRow>("SELECT id, pattern, category, created_at FROM category_rules WHERE user_id = ? AND pattern = ?", userId, pattern);
  let id = previous?.id;
  // Whoever sets it last is who it is shown as made by: an agent can't leave a correction looking like the person's.
  if (previous) ctx.db.run("UPDATE category_rules SET category = ?, created_by_kind = ?, created_by_name = ? WHERE id = ?", category, by.kind, by.name, previous.id);
  else {
    id = newId("crl");
    ctx.db.run(
      "INSERT INTO category_rules (id, user_id, pattern, category, created_by_kind, created_by_name, created_at) VALUES (?,?,?,?,?,?,?)",
      id, userId, pattern, category, by.kind, by.name, Date.now(),
    );
  }
  const moved = resortThreads(ctx, userId, threadsMatching(ctx, userId, pattern));
  return {
    rule: shape(ctx.db.get<RuleRow>("SELECT id, pattern, category, created_at FROM category_rules WHERE id = ?", id!)!),
    previous: previous && isCategory(previous.category) ? shape(previous) : null,
    moved,
  };
}

/** Stop correcting a sender, domain or mailing list: its mail is sorted by the usual rules again. */
export function deleteCategoryRule(ctx: AppContext, userId: string, id: string) {
  const row = ctx.db.get<RuleRow>("SELECT id, pattern, category, created_at FROM category_rules WHERE id = ? AND user_id = ?", id, userId);
  if (!row) throw new HttpError(404, "Correction not found");
  ctx.db.run("DELETE FROM category_rules WHERE id = ?", id);
  const moved = resortThreads(ctx, userId, threadsMatching(ctx, userId, row.pattern));
  return { rule: shape(row), moved };
}

/** "Moved mail from Humble Bundle to Promotions" */
export const describeMove = (label: string, category: Category) => `Moved mail from ${label} to ${CATEGORY_NAMES[category]}`;
