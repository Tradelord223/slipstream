import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { Events, ServerEvent } from "../events.ts";
import type { SecretBox } from "../lib/crypto.ts";
import { createProvider } from "../providers/index.ts";
import { BodyLoader } from "./bodies.ts";
import { CacheKeeper, KEEP_INBOX, newestInbox } from "./cache.ts";
import { buildOutgoing } from "./compose.ts";
import { resolveFrom, syncProviderIdentities } from "./identities.ts";
import type { AccountRow, MailStore } from "./store.ts";
import { PermanentProviderError, ProviderAuthError, type Address, type MailProvider, type RemoteAction } from "./types.ts";

const MAX_ATTEMPTS = 6;
/** The first sync reaches back this far; older mail stays at the provider until someone asks for it. */
const INITIAL_SYNC_DAYS = 30;
/** Bodies fetched at once for the recent cache by a provider that can only return them one by one: low, so it never crowds out what the person is doing. */
const RECENT_CONCURRENCY = 3;
/**
 * Messages of the first sync's history that get a preview: the newest ones, in one pass. Older history keeps empty snippets
 * until someone opens it, because on Gmail the first lines of 100 messages cost about 7.7 s and mail that old is rarely read
 * before it is searched for.
 */
const HISTORY_PREVIEWS = 300;
/** How often an account's send-as list is read from its provider. */
const IDENTITY_REFRESH_MS = 6 * 3_600_000;

type SyncProgress = NonNullable<Extract<ServerEvent, { type: "sync" }>["progress"]>;
/** `base`: items already done before this stage's work began. `rate: false`: the stage did no work, so it has no rate. */
type Report = (stage: SyncProgress["stage"], done: number, total: number | null, opts?: { base?: number; rate?: boolean }) => void;

interface DraftRow {
  id: string;
  user_id: string;
  account_id: string;
  from_email: string | null;
  thread_id: string | null;
  reply_to_message_id: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body_html: string;
  follow_up_days: number | null;
}

/**
 * Background work: pulls provider changes, pushes queued local actions, sends scheduled mail,
 * and brings reminders back. One instance per server process.
 */
export class SyncEngine {
  private providers = new Map<string, MailProvider>();
  private running = new Set<string>();
  /** When each account's send-as list was last read; empty after a restart, so the first sync reads it. */
  private identitiesReadAt = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private draining = false;
  /** Where each account's latest first sync is, so a reloaded dashboard shows the same numbers. */
  private progress = new Map<string, SyncProgress>();
  /** Full text for messages that were synced as summaries; shared by every reader of a body. */
  readonly bodies: BodyLoader;
  /** Keeps the cache of full text under its size limit. */
  readonly cache: CacheKeeper;

  private config: Config;
  private db: Db;
  private store: MailStore;
  private events: Events;
  private secrets: SecretBox;

  constructor(config: Config, db: Db, store: MailStore, events: Events, secrets: SecretBox) {
    this.config = config;
    this.db = db;
    this.store = store;
    this.events = events;
    this.secrets = secrets;
    this.cache = new CacheKeeper(db, store);
    this.bodies = new BodyLoader(db, store, events, (account) => this.provider(account), (ids) => this.cache.stored(ids));
  }

  /** The latest first-sync progress for an account, or null if this server hasn't run one. */
  progressOf(accountId: string): SyncProgress | null {
    return this.progress.get(accountId) ?? null;
  }

  start(): void {
    const every = (ms: number, fn: () => Promise<void> | void) => {
      const t = setInterval(() => void Promise.resolve(fn()).catch((e) => console.error("[slipstream] worker:", e)), ms);
      t.unref();
      this.timers.push(t);
    };
    every(1_000, () => this.tick());
    every(this.config.syncIntervalSeconds * 1000, () => this.syncAll());
    void this.syncAll();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.cache.stop();
    for (const p of this.providers.values()) await p.close?.().catch(() => {});
    this.providers.clear();
  }

  /** Fast loop: everything that's due within a second of the user expecting it. */
  async tick(now = Date.now()): Promise<void> {
    this.wakeReminders(now);
    await this.sendDue(now);
    await this.drainActions(now);
  }

  provider(account: AccountRow): MailProvider {
    let p = this.providers.get(account.id);
    if (!p) {
      p = createProvider(
        account.provider as AccountRow["provider"] & MailProvider["kind"],
        {
          accountId: account.id,
          email: account.email,
          auth: account.auth_enc ? this.secrets.open(account.auth_enc) : null,
          saveAuth: (auth) =>
            this.db.run("UPDATE accounts SET auth_enc = ? WHERE id = ?", this.secrets.seal(auth), account.id),
          initialSyncDays: INITIAL_SYNC_DAYS,
        },
        this.config,
      );
      this.providers.set(account.id, p);
    }
    return p;
  }

  /** Drop a cached provider (credentials changed or account removed). */
  async forget(accountId: string): Promise<void> {
    const p = this.providers.get(accountId);
    this.providers.delete(accountId);
    this.identitiesReadAt.delete(accountId);
    await p?.close?.().catch(() => {});
  }

  /**
   * Refresh the account's provider-sourced send-as addresses. It never fails the sync: if the provider can't say
   * (no permission, outage) the addresses already stored stay as they are, and the next try waits a full interval.
   */
  private async refreshIdentities(account: AccountRow, provider: MailProvider): Promise<void> {
    if (!provider.listIdentities) return;
    const now = Date.now();
    if (now - (this.identitiesReadAt.get(account.id) ?? 0) < IDENTITY_REFRESH_MS) return;
    this.identitiesReadAt.set(account.id, now);
    try {
      syncProviderIdentities(this.db, account.id, await provider.listIdentities());
    } catch (err) {
      console.warn(`[slipstream] send-as list for ${account.email}:`, err instanceof Error ? err.message : err);
    }
  }

  async syncAll(): Promise<void> {
    const accounts = this.db.all<AccountRow>("SELECT * FROM accounts WHERE sync_status != 'reauth'");
    await Promise.all(accounts.map((a) => this.syncAccount(a.id)));
  }

  async syncAccount(accountId: string): Promise<void> {
    if (this.running.has(accountId)) return;
    this.running.add(accountId);
    const account = this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId);
    if (!account) {
      this.running.delete(accountId);
      return;
    }
    const setStatus = (status: string, error: string | null = null) => {
      this.db.run(
        "UPDATE accounts SET sync_status = ?, sync_error = ?, last_synced_at = CASE WHEN ? = 'idle' THEN ? ELSE last_synced_at END WHERE id = ?",
        status,
        error,
        status,
        Date.now(),
        accountId,
      );
      this.events.emitToUser(account.user_id, { type: "sync", accountId, status, error });
    };
    setStatus("syncing");
    const run = { stage: null as SyncProgress["stage"] | null, done: 0, at: Date.now(), start: Date.now(), base: 0 };
    const report: Report = (next, d, t, opts = {}) => {
      const now = Date.now();
      // A stage is timed from where the one before it ended, so a stage that reports once (the inbox page) still has a duration.
      if (run.stage !== next) {
        run.start = run.at;
        run.base = opts.base ?? 0;
      }
      // The total follows the count if an estimate turned out low.
      run.stage = next;
      run.done = d;
      run.at = now;
      const p: SyncProgress = { stage: next, done: d, total: t === null ? null : Math.max(t, d) };
      // Items per second so far in this stage, for the client's time-remaining estimate. Not for a stage that did no work.
      if (opts.rate !== false && d > run.base) p.rate = (d - run.base) / (Math.max(now - run.start, 1) / 1000);
      this.progress.set(accountId, p);
      this.events.emitToUser(account.user_id, { type: "sync", accountId, status: "syncing", progress: p });
    };
    try {
      const provider = this.provider(account);
      let cursor = account.sync_cursor;
      let caughtUp = false;
      let fetched = 0;
      let recentDone = false;
      // History previews wait here until the budget is spent or the history ends, then go in one pass.
      let historyBudget = HISTORY_PREVIEWS;
      let held: string[] = [];
      if (account.first_synced_at === null && account.provider !== "archive") report("signin", 0, null);
      for (let pages = 0; pages < 500; pages++) {
        const page = await provider.sync(cursor);
        const touched = this.store.ingest(account, page);
        // The inbox opens before the rest of the window is in, and that mail is stored after the account was marked ready.
        // It is history, not news, so the mark moves past it right away, before delivery tidying can look at it.
        if (page.progress?.stage === "history" && account.provider !== "archive") {
          this.db.run("UPDATE accounts SET first_synced_at = ? WHERE id = ? AND first_synced_at IS NOT NULL", Date.now(), accountId);
        }
        cursor = page.cursor;
        this.db.run("UPDATE accounts SET sync_cursor = ? WHERE id = ?", cursor, accountId);
        if (touched.length) this.events.emitToUser(account.user_id, { type: "threads", accountId, threadIds: touched });
        // Progress for the first-run screen: how many messages this run has stored so far.
        if (page.messages.length > 0) {
          fetched += page.messages.length;
          this.events.emitToUser(account.user_id, { type: "sync", accountId, status: "syncing", fetched });
        }
        const sp = page.progress;
        let previewed = false;
        if (sp) {
          // A stage's page counts add up; the last page of a stage settles its total.
          const reached = (run.stage === sp.stage ? run.done : 0) + sp.count;
          report(sp.stage, reached, sp.last ? reached : sp.total);
          if (sp.stage === "inbox" && sp.last) {
            // The newest inbox mail is in: the dashboard can open now, while the rest of the window keeps arriving.
            if (account.provider !== "archive") this.db.run("UPDATE accounts SET first_synced_at = ? WHERE id = ? AND first_synced_at IS NULL", Date.now(), accountId);
            // It opened on headers alone. The newest messages come in full first: Gmail sends 50 whole messages faster than it
            // sends the first lines of 100 (measured: 2.3 s against 7.7 s), and a full message gives its own preview.
            await this.cacheRecent(account, report);
            recentDone = true;
            // Then first lines for the rest of the page, skipping what the full fetch already filled in.
            const ids = provider.fetchPreviews ? this.stillPreviewOnly(account.id, page.previewIds ?? []) : [];
            if (ids.length > 0) {
              report("previews", 0, ids.length);
              await this.fillPreviews(account, provider, ids);
              report("previews", ids.length, ids.length);
            } else {
              report("previews", page.messages.length, page.messages.length, { rate: false });
            }
            previewed = true;
          }
        }
        if (sp?.stage === "history" && page.previewIds?.length) {
          // History is newest first. The newest few hundred get previews, all in one pass: a pass costs a round trip per kind
          // of message however few it names. The rest keep empty snippets until opened.
          const take = page.previewIds.slice(0, Math.max(0, historyBudget));
          historyBudget -= take.length;
          held.push(...take);
        } else if (!previewed && page.previewIds?.length) {
          // New mail has its previews fetched right after it is stored, without a stage of its own.
          await this.fillPreviews(account, provider, page.previewIds);
        }
        if (held.length && (historyBudget <= 0 || page.done || (sp?.stage === "history" && sp.last))) {
          const ids = held;
          held = [];
          await this.fillPreviews(account, provider, ids);
        }
        if (page.done) {
          caughtUp = true;
          break;
        }
      }
      // The first sync that reaches the end of the mailbox: mail stored before it is history, not news.
      // An archive has nothing to fetch, so reaching its end proves nothing; its import stamps it when the file is read.
      if (caughtUp && account.provider !== "archive") this.db.run("UPDATE accounts SET first_synced_at = ? WHERE id = ? AND first_synced_at IS NULL", Date.now(), accountId);
      // New mail arrives as summaries; the newest of it is fetched in full for the same reason the first inbox page is.
      if (fetched > 0 && !recentDone) await this.cacheRecent(account);
      if (run.stage !== null) report("done", run.done, run.done, { rate: false });
      await this.refreshIdentities(account, provider);
      this.cache.enforce();
      setStatus("idle");
    } catch (err) {
      if (err instanceof ProviderAuthError) setStatus("reauth", err.message);
      else setStatus("error", err instanceof Error ? err.message : String(err));
      console.error(`[slipstream] sync ${account.email}:`, err instanceof Error ? err.message : err);
    } finally {
      this.running.delete(accountId);
    }
  }

  /**
   * Bring the previews of messages a page stored as headers only, in the provider's one round trip, and show them in the
   * open inbox. A preview that can't be fetched now is simply missing until the message is opened; only a sign-in problem
   * fails the sync.
   */
  private async fillPreviews(account: AccountRow, provider: MailProvider, remoteIds: string[]): Promise<void> {
    if (!provider.fetchPreviews) return;
    let previews: Map<string, string>;
    try {
      previews = await provider.fetchPreviews(remoteIds);
    } catch (err) {
      if (err instanceof ProviderAuthError) throw err;
      console.warn(`[slipstream] previews for ${account.email}:`, err instanceof Error ? err.message : err);
      return;
    }
    const touched = new Set<string>();
    this.db.tx(() => {
      for (const [remoteId, text] of previews) {
        const loc = this.db.get<{ message_id: string }>("SELECT message_id FROM message_locations WHERE account_id = ? AND remote_id = ?", account.id, remoteId);
        const threadId = loc && this.store.attachPreview(loc.message_id, text);
        if (threadId) touched.add(threadId);
      }
    });
    if (touched.size) this.events.emitToUser(account.user_id, { type: "threads", accountId: account.id, threadIds: [...touched] });
  }

  /** Of these remote ids, the ones whose message still has only its headers (no full text and no preview yet). */
  private stillPreviewOnly(accountId: string, remoteIds: string[]): string[] {
    if (remoteIds.length === 0) return [];
    const marks = remoteIds.map(() => "?").join(",");
    const filled = new Set(
      this.db
        .all<{ remote_id: string }>(`SELECT remote_id FROM messages WHERE account_id = ? AND remote_id IN (${marks}) AND body_state = 'cached'`, accountId, ...remoteIds)
        .map((r) => r.remote_id),
    );
    return remoteIds.filter((id) => !filled.has(id));
  }

  /**
   * Fetch the full text of the newest inbox messages that only have a preview: in one request when the provider can, else a
   * few at a time. Progress counts every message as it is settled, so the numbers are exact and only go up. A message that
   * can't be fetched now is simply opened later; nothing here fails a sync.
   */
  private async cacheRecent(account: AccountRow, report?: Report): Promise<void> {
    const rows = newestInbox((sql, ...p) => this.db.all(sql, ...p), account.id, KEEP_INBOX);
    const missing = rows.filter((r) => r.body_state === "none").map((r) => r.id);
    let done = rows.length - missing.length;
    const base = done;
    report?.("recent", done, rows.length, { base });
    await this.bodies.load(missing, { concurrency: RECENT_CONCURRENCY, onSettled: () => report?.("recent", ++done, rows.length, { base }) });
  }

  /** Push local triage to providers, oldest first, with exponential backoff. */
  async drainActions(now = Date.now()): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = this.db.all<{ id: number; account_id: string; payload: string; attempts: number }>(
        "SELECT id, account_id, payload, attempts FROM pending_actions WHERE status = 'queued' AND run_after <= ? ORDER BY id LIMIT 100",
        now,
      );
      for (const row of due) {
        const account = this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", row.account_id);
        if (!account) continue;
        this.db.run("UPDATE pending_actions SET status = 'running' WHERE id = ? AND status = 'queued'", row.id);
        const { action, threadId, labelOp } = JSON.parse(row.payload) as {
          action?: RemoteAction;
          threadId?: string;
          labelOp?: { kind: "rename" | "delete"; label: { remoteId: string; name: string }; newName?: string };
        };
        try {
          const provider = this.provider(account);
          if (labelOp?.kind === "rename") await provider.renameLabel?.(labelOp.label, labelOp.newName!);
          else if (labelOp?.kind === "delete") await provider.deleteLabel?.(labelOp.label);
          else if (action) await provider.apply(action);
          this.db.run("UPDATE pending_actions SET status = 'done', last_error = NULL WHERE id = ?", row.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const attempts = row.attempts + 1;
          const permanent = err instanceof PermanentProviderError || attempts >= MAX_ATTEMPTS;
          this.db.run(
            "UPDATE pending_actions SET status = ?, attempts = ?, last_error = ?, run_after = ? WHERE id = ?",
            permanent ? "failed" : "queued",
            attempts,
            msg,
            now + 5_000 * 2 ** attempts,
            row.id,
          );
          if (err instanceof ProviderAuthError) this.db.run("UPDATE accounts SET sync_status = 'reauth', sync_error = ? WHERE id = ?", msg, account.id);
        }
        // The thread's provider state may now agree with local state; let recompute settle it.
        if (threadId) {
          this.store.recomputeThread(threadId);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Remind Me and follow-up reminders: bring threads back to the top of the inbox. */
  wakeReminders(now = Date.now()): void {
    const due = this.db.all<{ id: string; account_id: string; user_id: string; follow_up_at: number | null; snoozed_until: number | null; last_inbound_at: number | null; last_outbound_at: number | null }>(
      `SELECT t.id, t.account_id, a.user_id, t.follow_up_at, t.snoozed_until, t.last_inbound_at, t.last_outbound_at
       FROM threads t JOIN accounts a ON a.id = t.account_id
       WHERE (t.snoozed_until IS NOT NULL AND t.snoozed_until <= ?) OR (t.follow_up_at IS NOT NULL AND t.follow_up_at <= ?)`,
      now,
      now,
    );
    if (due.length === 0) return;
    const byUser = new Map<string, { accountId: string; ids: string[] }>();
    this.db.tx(() => {
      for (const t of due) {
        const isFollowUp = !(t.snoozed_until && t.snoozed_until <= now);
        const replied = (t.last_inbound_at ?? 0) > (t.last_outbound_at ?? 0);
        if (isFollowUp && replied) {
          this.db.run("UPDATE threads SET follow_up_at = NULL WHERE id = ?", t.id);
          continue;
        }
        this.db.run(
          `UPDATE threads SET in_inbox = 1, snoozed_until = NULL, follow_up_at = NULL, done_at = NULL,
             reminded_at = ?, sort_at = ?, updated_at = ? WHERE id = ?`,
          now, now, now, t.id,
        );
        this.db.run("UPDATE messages SET in_inbox = 1 WHERE thread_id = ?", t.id);
        this.store.mirrorLocations(t.id);
        const ref = this.store.threadRef(t.id);
        this.db.run(
          "INSERT INTO pending_actions (account_id, kind, payload, run_after, created_at) VALUES (?,?,?,?,?)",
          t.account_id,
          "unarchive",
          JSON.stringify({ threadId: t.id, action: { kind: "unarchive", threadRemoteId: ref.threadRemoteId, messages: ref.messages } }),
          now,
          now,
        );
        const entry = byUser.get(t.user_id) ?? { accountId: t.account_id, ids: [] };
        entry.ids.push(t.id);
        byUser.set(t.user_id, entry);
      }
    });
    for (const [userId, e] of byUser) this.events.emitToUser(userId, { type: "threads", accountId: e.accountId, threadIds: e.ids });
  }

  /** Send drafts whose undo window or scheduled time has passed. */
  async sendDue(now = Date.now()): Promise<void> {
    const due = this.db.all<DraftRow>(
      "SELECT * FROM drafts WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT 20",
      now,
    );
    for (const d of due) {
      const claimed = this.db.run("UPDATE drafts SET status = 'sending' WHERE id = ? AND status = 'scheduled'", d.id);
      if (claimed.changes === 0) continue;
      this.events.emitToUser(d.user_id, { type: "drafts", draftId: d.id, status: "sending" });
      try {
        await this.sendDraft(d);
        this.db.run("UPDATE drafts SET status = 'sent', error = NULL, updated_at = ? WHERE id = ?", Date.now(), d.id);
        this.events.emitToUser(d.user_id, { type: "drafts", draftId: d.id, status: "sent" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.run("UPDATE drafts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", msg, Date.now(), d.id);
        this.events.emitToUser(d.user_id, { type: "drafts", draftId: d.id, status: "failed", error: msg });
      }
    }
  }

  private async sendDraft(d: DraftRow): Promise<void> {
    const account = this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", d.account_id);
    if (!account) throw new Error("The sending account no longer exists");
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let threadRemoteId: string | undefined;
    if (d.thread_id) {
      const parent = d.reply_to_message_id
        ? this.db.get<{ message_id_header: string | null; refs: string | null }>(
            "SELECT message_id_header, refs FROM messages WHERE id = ?",
            d.reply_to_message_id,
          )
        : this.db.get<{ message_id_header: string | null; refs: string | null }>(
            "SELECT message_id_header, refs FROM messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1",
            d.thread_id,
          );
      if (parent?.message_id_header) {
        inReplyTo = parent.message_id_header;
        references = [...(parent.refs?.split(/\s+/).filter(Boolean) ?? []), parent.message_id_header];
      }
      threadRemoteId = this.db.get<{ remote_id: string }>("SELECT remote_id FROM threads WHERE id = ?", d.thread_id)?.remote_id;
    }
    const attachments = this.db
      .all<{ filename: string; mime_type: string; blob_sha256: string }>(
        "SELECT filename, mime_type, blob_sha256 FROM draft_attachments WHERE draft_id = ?",
        d.id,
      )
      .map((a) => ({ filename: a.filename, mimeType: a.mime_type, content: this.store.readBlob(a.blob_sha256)! }))
      .filter((a) => a.content);

    // Checked again now: the address may have been removed since the draft was written or queued.
    const sender = resolveFrom(this.db, account.id, d.from_email);
    const from: Address = { name: sender.name, email: sender.email };
    const outgoing = await buildOutgoing({
      from,
      replyTo: sender.replyTo ?? undefined,
      to: JSON.parse(d.to_json),
      cc: JSON.parse(d.cc_json),
      bcc: JSON.parse(d.bcc_json),
      subject: d.subject,
      html: d.body_html,
      inReplyTo,
      references,
      threadRemoteId: threadRemoteId?.startsWith("ref:") ? undefined : threadRemoteId,
      attachments,
    });
    const result = await this.provider(account).apply({ kind: "send", message: outgoing });
    const remoteId = (result && "remoteId" in result && result.remoteId) || `sent:${outgoing.messageIdHeader}`;

    // Show the sent message in its thread right away; the next sync dedupes by Message-ID.
    const touched = this.store.ingest(account, {
      messages: [
        {
          remoteId,
          remoteThreadId: threadRemoteId,
          messageIdHeader: outgoing.messageIdHeader,
          inReplyTo,
          references,
          from,
          replyTo: sender.replyTo ?? undefined,
          to: outgoing.to,
          cc: outgoing.cc,
          bcc: outgoing.bcc,
          subject: d.subject,
          sentAt: Date.now(),
          bodyText: outgoing.text,
          bodyHtml: d.body_html,
          unread: false,
          starred: false,
          folders: { inbox: false, sent: true, trash: false, spam: false },
          outgoing: true,
          attachments: attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.content.length, inline: false, content: a.content })),
        },
      ],
      cursor: account.sync_cursor,
      done: true,
    });
    if (d.follow_up_days && touched[0]) {
      this.db.run("UPDATE threads SET follow_up_at = ? WHERE id = ?", Date.now() + d.follow_up_days * 86_400_000, touched[0]);
    }
    this.events.emitToUser(account.user_id, { type: "threads", accountId: account.id, threadIds: touched });
  }
}
