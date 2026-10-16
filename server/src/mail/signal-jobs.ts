import type { AppContext } from "../context.ts";
import { registrableDomain } from "./logos.ts";
import { scanSignals } from "./signals.ts";

/** Background work behind everyday signals: scanning mail that predates them, and tidying superseded delivery updates. */

interface ScanRow {
  id: string;
  thread_id: string;
  account_id: string;
  subject: string;
  from_email: string;
  from_name: string;
  body_text: string;
  is_bulk: number;
  outgoing: number;
  sent_at: number;
}

/**
 * Scan messages stored before signals existed (signals IS NULL), newest first, in small batches that
 * yield to the event loop so the server stays responsive. Idempotent: every scanned row gets a value
 * (an empty list when nothing was found), so a second run finds nothing to do.
 *
 * Each batch tells open dashboards about the conversations whose signals changed, so chips appear without a reload.
 */
export async function backfillSignals(ctx: AppContext, opts: { batch?: number; signal?: AbortSignal } = {}): Promise<number> {
  const batch = opts.batch ?? 500;
  let scanned = 0;
  while (!opts.signal?.aborted) {
    const rows = ctx.db.all<ScanRow>(
      `SELECT id, thread_id, account_id, subject, from_email, from_name, body_text, is_bulk, outgoing, sent_at
       FROM messages WHERE signals IS NULL ORDER BY sent_at DESC LIMIT ?`,
      batch,
    );
    if (rows.length === 0) break;
    const threads = new Set<string>();
    const changed: string[] = [];
    ctx.db.tx(() => {
      for (const r of rows) {
        const signals = r.outgoing
          ? []
          : scanSignals({ subject: r.subject, fromEmail: r.from_email, fromName: r.from_name, text: r.body_text, isBulk: Boolean(r.is_bulk), sentAt: r.sent_at });
        ctx.db.run("UPDATE messages SET signals = ? WHERE id = ?", JSON.stringify(signals), r.id);
        threads.add(r.thread_id);
      }
      const chips = (id: string) => ctx.db.get<{ signal: string | null }>("SELECT signal FROM threads WHERE id = ?", id)?.signal ?? null;
      for (const id of threads) {
        const before = chips(id);
        ctx.store.recomputeThread(id);
        if (chips(id) !== before) changed.push(id);
      }
    });
    announce(ctx, rows, changed);
    scanned += rows.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (scanned > 0) console.log(`[slipstream] scanned ${scanned} older messages for codes, deliveries and alerts`);
  return scanned;
}

/** One threads event per person for a batch's changed conversations. */
function announce(ctx: AppContext, rows: ScanRow[], changed: string[]) {
  if (changed.length === 0) return;
  const accountOf = new Map(rows.map((r) => [r.thread_id, r.account_id]));
  const byUser = new Map<string, string[]>();
  for (const id of changed) {
    const userId = ctx.db.get<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = ?", accountOf.get(id) ?? "")?.user_id;
    if (userId) byUser.set(userId, [...(byUser.get(userId) ?? []), id]);
  }
  for (const [userId, threadIds] of byUser) ctx.events.emitToUser(userId, { type: "threads", accountId: "", threadIds });
}

/**
 * Fill in messages.sender_domain (the indexed domain behind sender logos) for mail stored before it existed.
 * Same shape as the signals backfill: small batches, yielding between them, and every row gets a value
 * ('' when the address has no registrable domain), so a second run finds nothing to do.
 */
export async function backfillSenderDomains(ctx: AppContext, opts: { batch?: number; signal?: AbortSignal } = {}): Promise<number> {
  const batch = opts.batch ?? 1000;
  let filled = 0;
  while (!opts.signal?.aborted) {
    const rows = ctx.db.all<{ id: string; from_email: string }>("SELECT id, from_email FROM messages WHERE sender_domain IS NULL LIMIT ?", batch);
    if (rows.length === 0) break;
    ctx.db.tx(() => {
      for (const r of rows) ctx.db.run("UPDATE messages SET sender_domain = ? WHERE id = ?", registrableDomain(r.from_email) ?? "", r.id);
    });
    filled += rows.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return filled;
}

const WATERMARK_KEY = "bundle:deliveriesAt";
const STARTED_AT = Date.now();
/** Only updates sent in the last few days count as arriving. An import, or a provider handing over old mail late, stores old mail as "new". */
const FRESH_MS = 3 * 86_400_000;

/**
 * When a newer update arrives for a package (same tracking number), the older updates in the inbox are
 * out of date: mark them done, once per batch, undoably, as "Slipstream". Only conversations nobody has
 * touched are moved: not starred, never replied to. Sign-in alerts and urgent mail are never candidates,
 * because only conversations whose top signal is a delivery are looked at.
 *
 * Works from new mail only: mail that arrived after its account's first sync finished (so a freshly connected
 * account's history, which a first sync stores as "new", is never archived at the provider), was stored since
 * the last pass, and was sent in the last few days. An old inbox isn't swept on upgrade, and a conversation
 * someone moves back stays where they put it. When an older update turns up after a newer one, the older
 * one is the one that steps aside.
 *
 * The pass's watermark moves only after its work succeeded, so a failure is retried with the same mail,
 * and one person's failure never holds up anyone else's.
 */
export function bundleDeliveries(ctx: AppContext, now = Date.now()): number {
  let moved = 0;
  for (const { user_id: userId } of ctx.db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM accounts")) {
    try {
      moved += bundleForUser(ctx, userId, now);
    } catch (err) {
      console.error("[slipstream] delivery tidying:", err);
    }
  }
  return moved;
}

function bundleForUser(ctx: AppContext, userId: string, now: number): number {
  const { db } = ctx;
  const stored = db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = ?", userId, WATERMARK_KEY);
  const since = stored ? Number(stored.value) : STARTED_AT;
  const advance = () =>
    db.run("INSERT INTO settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value", userId, WATERMARK_KEY, String(now));
  if (deliveriesSetting(ctx, userId) !== "latest") {
    advance();
    return 0;
  }

  // Packages with an update that is new in the sense above. Each package is judged on every update in the inbox, not only the new one.
  const packages = db.all<{ tracking: string }>(
    `SELECT DISTINCT upper(json_extract(t.signal, '$[0].tracking')) AS tracking
     FROM threads t JOIN accounts a ON a.id = t.account_id
     WHERE a.user_id = ? AND t.in_inbox = 1 AND json_extract(t.signal, '$[0].kind') = 'delivery'
       AND json_extract(t.signal, '$[0].tracking') IS NOT NULL
       AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.outgoing = 0 AND m.created_at >= ? AND m.created_at < ? AND m.sent_at > ?
                     AND a.first_synced_at IS NOT NULL AND m.created_at > a.first_synced_at)`,
    userId,
    since,
    now,
    now - FRESH_MS,
  );
  const older = new Set<string>();
  for (const { tracking } of packages) {
    const updates = db.all<{ id: string; signal_at: number | null; starred: number; in_sent: number }>(
      `SELECT t.id, t.signal_at, t.starred, t.in_sent FROM threads t JOIN accounts a ON a.id = t.account_id
       WHERE a.user_id = ? AND t.in_inbox = 1 AND json_extract(t.signal, '$[0].kind') = 'delivery'
         AND upper(json_extract(t.signal, '$[0].tracking')) = ?`,
      userId,
      tracking,
    );
    const newest = Math.max(...updates.map((u) => u.signal_at ?? 0));
    for (const u of updates) if (!u.starred && !u.in_sent && (u.signal_at ?? 0) < newest) older.add(u.id);
  }

  let tidied = 0;
  if (older.size > 0) {
    const res = ctx.triage.apply(userId, { kind: "done", threadIds: [...older] }, now);
    const user = ctx.users.get(userId);
    if (user) {
      const n = res.threadIds.length;
      ctx.commands.record({ kind: "human", user: { ...user, name: "Slipstream" } }, "deliveries.bundle", `Tidied ${n === 1 ? "an older update" : `${n} older updates`} for a package that has a newer one`, {
        threadIds: res.threadIds,
        undoToken: res.undoToken,
        inverse: { command: "triage.inbox", input: { threadIds: res.threadIds } },
      });
    }
    ctx.events.emitToUser(userId, { type: "threads", accountId: "", threadIds: res.threadIds });
    tidied = res.threadIds.length;
  }
  advance();
  return tidied;
}

function deliveriesSetting(ctx: AppContext, userId: string): "latest" | "all" {
  const row = ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = 'helpers'", userId);
  try {
    const helpers = row ? (JSON.parse(row.value) as { deliveries?: string }) : {};
    return helpers.deliveries === "all" ? "all" : "latest";
  } catch {
    return "latest";
  }
}
