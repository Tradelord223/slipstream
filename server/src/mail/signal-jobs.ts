import type { AppContext } from "../context.ts";
import { scanSignals } from "./signals.ts";

/** Background work behind everyday signals: scanning mail that predates them, and tidying superseded delivery updates. */

interface ScanRow {
  id: string;
  thread_id: string;
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
 */
export async function backfillSignals(ctx: AppContext, opts: { batch?: number; signal?: AbortSignal } = {}): Promise<number> {
  const batch = opts.batch ?? 500;
  let scanned = 0;
  while (!opts.signal?.aborted) {
    const rows = ctx.db.all<ScanRow>(
      `SELECT id, thread_id, subject, from_email, from_name, body_text, is_bulk, outgoing, sent_at
       FROM messages WHERE signals IS NULL ORDER BY sent_at DESC LIMIT ?`,
      batch,
    );
    if (rows.length === 0) break;
    const threads = new Set<string>();
    ctx.db.tx(() => {
      for (const r of rows) {
        const signals = r.outgoing
          ? []
          : scanSignals({ subject: r.subject, fromEmail: r.from_email, fromName: r.from_name, text: r.body_text, isBulk: Boolean(r.is_bulk), sentAt: r.sent_at });
        ctx.db.run("UPDATE messages SET signals = ? WHERE id = ?", JSON.stringify(signals), r.id);
        threads.add(r.thread_id);
      }
      for (const id of threads) ctx.store.recomputeThread(id);
    });
    scanned += rows.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (scanned > 0) console.log(`[slipstream] scanned ${scanned} older messages for codes, deliveries and alerts`);
  return scanned;
}

const WATERMARK_KEY = "bundle:deliveriesAt";
const STARTED_AT = Date.now();
/** Only updates sent in the last few days count as arriving. A newly connected account or an import stores old mail as "new". */
const FRESH_MS = 3 * 86_400_000;

/**
 * When a newer update arrives for a package (same tracking number), the older updates in the inbox are
 * out of date: mark them done, once per batch, undoably, as "Slipstream". Only conversations nobody has
 * touched are moved: not starred, never replied to. Sign-in alerts and urgent mail are never candidates,
 * because only conversations whose top signal is a delivery are looked at.
 *
 * Works from new mail only (stored since the last pass and sent in the last few days), so an old inbox isn't
 * swept on upgrade, a freshly connected account's history isn't archived, and a conversation someone moves
 * back stays where they put it.
 */
export function bundleDeliveries(ctx: AppContext, now = Date.now()): number {
  const { db } = ctx;
  let moved = 0;
  for (const { user_id: userId } of db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM accounts")) {
    const stored = db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = ?", userId, WATERMARK_KEY);
    const since = stored ? Number(stored.value) : STARTED_AT;
    db.run(
      "INSERT INTO settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
      userId,
      WATERMARK_KEY,
      String(now),
    );
    if (deliveriesSetting(ctx, userId) !== "latest") continue;

    const fresh = db.all<{ id: string; tracking: string; signal_at: number }>(
      `SELECT t.id, upper(json_extract(t.signal, '$.tracking')) AS tracking, t.signal_at
       FROM threads t JOIN accounts a ON a.id = t.account_id
       WHERE a.user_id = ? AND t.in_inbox = 1 AND json_extract(t.signal, '$.kind') = 'delivery'
         AND json_extract(t.signal, '$.tracking') IS NOT NULL
         AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.outgoing = 0 AND m.created_at >= ? AND m.created_at < ? AND m.sent_at > ?)`,
      userId,
      since,
      now,
      now - FRESH_MS,
    );
    const older = new Set<string>();
    for (const f of fresh) {
      for (const o of db.all<{ id: string }>(
        `SELECT t.id FROM threads t JOIN accounts a ON a.id = t.account_id
         WHERE a.user_id = ? AND t.id != ? AND t.in_inbox = 1 AND t.starred = 0 AND t.in_sent = 0
           AND json_extract(t.signal, '$.kind') = 'delivery' AND upper(json_extract(t.signal, '$.tracking')) = ?
           AND t.signal_at < ?`,
        userId,
        f.id,
        f.tracking,
        f.signal_at,
      ))
        older.add(o.id);
    }
    if (older.size === 0) continue;

    const ids = [...older];
    const res = ctx.triage.apply(userId, { kind: "done", threadIds: ids }, now);
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
    moved += res.threadIds.length;
  }
  return moved;
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
