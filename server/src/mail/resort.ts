import type { AppContext } from "../context.ts";
import { ProviderAuthError, type MailProvider, type SortingHints } from "./types.ts";
import { isBulkMessage } from "./classify.ts";
import { scanSignals } from "./signals.ts";
import type { Query } from "./cache.ts";
import type { AccountRow } from "./store.ts";

/**
 * The one-time re-sort. Mail synced before 0.5.0 was stored without its List-Id, often without List-Unsubscribe, and without the
 * provider's own category, so the old rule ("no list headers means a person wrote it") filed stores under Important. For each
 * account this fetches those headers again for incoming mail that lacks them (the four header lines only, never a body; by UID on
 * IMAP, as metadata on Gmail and Graph), then sorts every conversation again.
 *
 * It only changes which tab a conversation shows in: folders, flags, labels and reminders are never touched, and nothing is written
 * to the provider. Progress is the messages' own `headers_version` flag, so a stop (or a restart) resumes where it left off, and the
 * account's `maintenance` row is written only when it has finished.
 */

/** Bump when the sorting rules change enough that everyone's mail should be sorted again. */
const SORT_VERSION = 1;
export const sortTask = (accountId: string) => `sort-${SORT_VERSION}:${accountId}`;

/** Providers that can be asked for headers again. Demo and imported mail has nothing to ask. */
const FETCHABLE = ["gmail", "outlook", "imap"];

const BATCH = 50;
const PAUSE_MS = 1_000;
const IDLE_MS = 60_000;
const FIRST_RUN_MS = 15_000;
/** Times one message may fail on its own before it is given up on, if the account has synced since (see Resorter.fetchHints). */
const MAX_STRIKES = 3;
/** Conversations sorted again per turn of the final pass. */
const PASS_BATCH = 200;

export interface ResortOptions {
  /** Messages whose headers are fetched per request. */
  batch?: number;
  /** Rest between requests, so a big mailbox is never hammered. */
  pauseMs?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface BatchRow {
  id: string;
  thread_id: string;
  remote_id: string;
  message_id_header: string | null;
  from_email: string;
  is_bulk: number;
  list_unsubscribe: string | null;
  signals: string | null;
}

export class Resorter {
  private ctx: AppContext;
  private timer?: NodeJS.Timeout;
  private abort = new AbortController();
  private running = false;
  /** Accounts that failed this round, with the reason, so a stuck one is logged once and not every minute. */
  private failing = new Map<string, string>();
  /** Messages the provider failed on when asked alone: how often, and since when. Kept across rounds, not across restarts. */
  private strikes = new Map<string, { count: number; since: number }>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** Begin in the background: shortly after boot, then every minute for accounts that still have work (or were just added). */
  start(): void {
    const tick = () => {
      void this.run({ signal: this.abort.signal })
        .catch((err) => console.error("[slipstream] re-sort:", err))
        .finally(() => {
          if (!this.abort.signal.aborted) this.timer = setTimeout(tick, IDLE_MS).unref();
        });
    };
    this.timer = setTimeout(tick, FIRST_RUN_MS).unref();
  }

  stop(): void {
    this.abort.abort();
    clearTimeout(this.timer);
  }

  /** Re-sort every account that hasn't been, one after the other. Returns once they are all done, failed this round, or `signal` fired. */
  async run(opts: ResortOptions = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const accounts = this.ctx.db.all<AccountRow>("SELECT * FROM accounts ORDER BY created_at");
      for (const account of accounts) {
        if (opts.signal?.aborted) return;
        try {
          await this.resortAccount(account, opts);
          this.failing.delete(account.id);
        } catch (err) {
          // The work so far is kept (it is in the messages' flags); the next round carries on.
          const why = err instanceof Error ? err.message : String(err);
          if (this.failing.get(account.id) !== why) console.warn(`[slipstream] re-sort of ${account.email} will try again: ${why}`);
          this.failing.set(account.id, why);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Whether an account has been sorted by the current rules. */
  done(accountId: string): boolean {
    return Boolean(this.ctx.db.get("SELECT 1 AS x FROM maintenance WHERE task = ?", sortTask(accountId)));
  }

  private async resortAccount(account: AccountRow, opts: ResortOptions): Promise<void> {
    const { db, store } = this.ctx;
    // Once finished, only mail still waiting for its headers is looked at: a Gmail page whose tab lookup a restart cut short.
    const finished = this.done(account.id);
    if (finished && !db.get(
      "SELECT 1 AS x FROM messages WHERE account_id = ? AND outgoing = 0 AND headers_version = 0 AND orphaned_at IS NULL AND remote_id NOT LIKE 'local:%' AND remote_id NOT LIKE 'sent:%' LIMIT 1",
      account.id,
    )) return;
    // Nothing to work from until the account has synced once, and nobody to ask while it needs a new sign-in.
    if (account.first_synced_at === null && account.provider !== "archive") return;
    if (account.sync_status === "reauth") return;

    const changed = new Set<string>();
    let fetched = 0;
    const signal = opts.signal;

    const provider = FETCHABLE.includes(account.provider) ? this.ctx.sync.provider(account) : null;
    // Messages to ask about again next round; the final pass waits for them.
    const retry = new Set<string>();
    if (provider?.fetchSortingHints) {
      for (;;) {
        if (signal?.aborted) return;
        const rows = db.all<BatchRow>(
          `SELECT id, thread_id, remote_id, message_id_header, from_email, is_bulk, list_unsubscribe, signals FROM messages
           WHERE account_id = ? AND outgoing = 0 AND headers_version = 0 AND orphaned_at IS NULL
             AND remote_id NOT LIKE 'local:%' AND remote_id NOT LIKE 'sent:%'
           ORDER BY in_inbox DESC, sent_at DESC LIMIT ?`,
          account.id,
          (opts.batch ?? BATCH) + retry.size,
        ).filter((r) => !retry.has(r.id)).slice(0, opts.batch ?? BATCH);
        if (rows.length === 0) break;
        let hints: Map<string, SortingHints> | null;
        try {
          hints = await this.fetchHints(account, provider.fetchSortingHints.bind(provider), rows, signal);
        } catch (err) {
          if (err instanceof ProviderAuthError) return;
          throw err;
        }
        if (!hints) return;
        const threads = new Set<string>();
        db.tx(() => {
          for (const r of rows) {
            const h = hints.get(r.remote_id);
            if (!h && this.strikes.has(r.id)) {
              retry.add(r.id);
              continue;
            }
            // Gone from the provider (or renumbered, or one it has failed on for good): nothing more to learn, and it is not asked for again.
            if (!h) {
              db.run("UPDATE messages SET headers_version = 2 WHERE id = ?", r.id);
              continue;
            }
            const unsubscribe = h.listUnsubscribe ?? r.list_unsubscribe;
            // A message only ever becomes bulk here: what the headers say adds to what was already known.
            const bulk = Boolean(r.is_bulk) || isBulkMessage({ from: { name: "", email: r.from_email }, bulk: h.bulk, listUnsubscribe: unsubscribe });
            db.run(
              `UPDATE messages SET list_id = ?, list_unsubscribe = coalesce(list_unsubscribe, ?), is_bulk = ?,
                 provider_category = coalesce(?, provider_category), headers_version = 1 WHERE id = ?`,
              h.listId ?? null,
              h.listUnsubscribe ?? null,
              bulk ? 1 : 0,
              h.providerCategory ?? null,
              r.id,
            );
            // Newly known to be bulk: its signals were read as a person's mail, so a sale blast may carry a delivery chip.
            if (bulk && !r.is_bulk && r.signals?.includes('"delivery"')) this.rescanSignals(r.id);
            threads.add(r.thread_id);
          }
        });
        fetched += rows.length;
        this.sortAgain(account, [...threads], changed);
        await sleep(opts.pauseMs ?? PAUSE_MS, signal);
      }
    }

    if (retry.size > 0 || finished) return;
    // Everything that sorting reads has to be in place before the final pass looks at every conversation.
    const waiting = db.get<{ x: number }>(
      "SELECT 1 AS x FROM messages WHERE account_id = ? AND (sender_domain IS NULL OR signals IS NULL) LIMIT 1",
      account.id,
    );
    if (waiting) return;

    let after = -1;
    while (!signal?.aborted) {
      const page = db.all<{ rowid: number; id: string }>(
        "SELECT rowid, id FROM threads WHERE account_id = ? AND rowid > ? ORDER BY rowid LIMIT ?",
        account.id,
        after,
        PASS_BATCH,
      );
      if (page.length === 0) break;
      after = page[page.length - 1]!.rowid;
      this.sortAgain(account, page.map((p) => p.id), changed);
      await yieldToLoop();
    }
    if (signal?.aborted) return;

    db.run("INSERT OR REPLACE INTO maintenance (task, ran_at) VALUES (?, ?)", sortTask(account.id), Date.now());
    if ((changed.size > 0 || fetched > 0) && account.provider !== "demo") this.record(account, changed.size);
  }

  /**
   * The headers of one batch. If the provider fails on the batch, each message is asked for on its own. One that still fails gets a
   * strike and is left out of the answer; while it has strikes the caller keeps it for a later round. It is given up on (left out
   * with no strike, so the caller finishes it as it is) only after MAX_STRIKES failures and a successful sync of the account since
   * the first, which shows the provider was up and the message itself is the trouble. When every message fails alone, the provider
   * is probably down: the strikes are still counted, but that throws and a later round asks again. Null when `signal` fired.
   */
  private async fetchHints(account: AccountRow, ask: NonNullable<MailProvider["fetchSortingHints"]>, rows: BatchRow[], signal?: AbortSignal): Promise<Map<string, SortingHints> | null> {
    const refs = (batch: BatchRow[]) => batch.map((r) => ({ remoteId: r.remote_id, messageIdHeader: r.message_id_header }));
    try {
      const hints = await ask(refs(rows));
      for (const r of rows) this.strikes.delete(r.id);
      return hints;
    } catch (err) {
      if (err instanceof ProviderAuthError) throw err;
      const hints = new Map<string, SortingHints>();
      const failed: BatchRow[] = [];
      for (const r of rows) {
        if (signal?.aborted) return null;
        try {
          for (const [id, h] of await ask(refs([r]))) hints.set(id, h);
          this.strikes.delete(r.id);
        } catch (one) {
          if (one instanceof ProviderAuthError) throw one;
          failed.push(r);
        }
      }
      const synced = this.ctx.db.get<{ last_synced_at: number | null }>("SELECT last_synced_at FROM accounts WHERE id = ?", account.id)?.last_synced_at ?? 0;
      let given = 0;
      for (const r of failed) {
        const s = this.strikes.get(r.id) ?? { count: 0, since: Date.now() };
        s.count++;
        if (s.count >= MAX_STRIKES && synced > s.since) {
          this.strikes.delete(r.id);
          given++;
        } else this.strikes.set(r.id, s);
      }
      if (given > 0) console.warn(`[slipstream] re-sort of ${account.email}: ${given} messages could not be fetched (${err instanceof Error ? err.message : err}); they are sorted as they are`);
      // Nothing answered and nothing was given up: end the round rather than walk the whole backlog against a provider that is down.
      if (failed.length === rows.length && given === 0) throw err;
      return hints;
    }
  }

  /** Read one message's signals again (it has just turned out to be bulk) and refresh its conversation's chip. */
  private rescanSignals(messageId: string): void {
    const m = this.ctx.db.get<{ thread_id: string; subject: string; from_email: string; from_name: string; body_text: string; sent_at: number }>(
      "SELECT thread_id, subject, from_email, from_name, body_text, sent_at FROM messages WHERE id = ?",
      messageId,
    );
    if (!m) return;
    const signals = scanSignals({ subject: m.subject, fromEmail: m.from_email, fromName: m.from_name, text: m.body_text, isBulk: true, sentAt: m.sent_at });
    this.ctx.db.run("UPDATE messages SET signals = ? WHERE id = ?", JSON.stringify(signals), messageId);
    this.ctx.store.recomputeThread(m.thread_id);
  }

  /** Sort conversations again and tell the open dashboard which ones moved. A fresh read of the corrections each time, so one made meanwhile is never undone. */
  private sortAgain(account: AccountRow, threadIds: string[], changed: Set<string>): void {
    if (threadIds.length === 0) return;
    const moved = this.ctx.store.recategorize(threadIds);
    for (const id of moved) changed.add(id);
    for (let i = 0; i < moved.length; i += 200) this.ctx.events.emitToUser(account.user_id, { type: "threads", accountId: account.id, threadIds: moved.slice(i, i + 200) });
  }

  /** One line in Activity under Slipstream's own name, and no undo: it only changes which tab mail shows in. */
  private record(account: AccountRow, conversations: number): void {
    const user = this.ctx.users.get(account.user_id);
    if (!user) return;
    const many = this.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM accounts WHERE user_id = ? AND provider != 'demo'", account.user_id)!.n > 1;
    const count = `${conversations.toLocaleString("en-US")} ${conversations === 1 ? "conversation" : "conversations"}`;
    // Slipstream did this, not the person (the same stand-in as the tidying of old delivery updates).
    this.ctx.commands.record({ kind: "human", user: { ...user, name: "Slipstream" } }, "mail.resort", `Re-sorted ${count}${many ? ` in ${account.email}` : ""}`, {});
  }
}

/**
 * Where the re-sort stands, for `slipstream doctor`: null for an install with no real mail account (or a database from before the
 * re-sort existed). `percent` counts incoming mail whose headers are in place, and stays under 100 until every account is done.
 */
export function sortingStatus(query: Query): { done: boolean; percent: number } | null {
  const accounts = query<{ id: string; provider: string }>("SELECT id, provider FROM accounts WHERE provider != 'demo'");
  if (accounts.length === 0) return null;
  const finished = new Set(query<{ task: string }>("SELECT task FROM maintenance WHERE task LIKE ?", `sort-${SORT_VERSION}:%`).map((r) => r.task));
  if (accounts.every((a) => finished.has(sortTask(a.id)))) return { done: true, percent: 100 };
  const counts = query<{ total: number; missing: number }>(
    `SELECT count(*) AS total, coalesce(sum(m.headers_version = 0), 0) AS missing FROM messages m JOIN accounts a ON a.id = m.account_id
     WHERE m.outgoing = 0 AND a.provider IN ('gmail','outlook','imap')`,
  )[0]!;
  const percent = counts.total === 0 ? 0 : Math.min(99, Math.floor(((counts.total - counts.missing) / counts.total) * 100));
  return { done: false, percent };
}
