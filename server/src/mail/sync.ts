import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { Events } from "../events.ts";
import type { SecretBox } from "../lib/crypto.ts";
import { createProvider } from "../providers/index.ts";
import { buildOutgoing } from "./compose.ts";
import type { AccountRow, MailStore } from "./store.ts";
import { PermanentProviderError, ProviderAuthError, type Address, type MailProvider, type RemoteAction } from "./types.ts";

const MAX_ATTEMPTS = 6;

interface DraftRow {
  id: string;
  user_id: string;
  account_id: string;
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
  private timers: NodeJS.Timeout[] = [];
  private draining = false;

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
          initialSyncDays: 120,
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
    await p?.close?.().catch(() => {});
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
    try {
      const provider = this.provider(account);
      let cursor = account.sync_cursor;
      for (let pages = 0; pages < 500; pages++) {
        const page = await provider.sync(cursor);
        const touched = this.store.ingest(account, page);
        cursor = page.cursor;
        this.db.run("UPDATE accounts SET sync_cursor = ? WHERE id = ?", cursor, accountId);
        if (touched.length) this.events.emitToUser(account.user_id, { type: "threads", accountId, threadIds: touched });
        if (page.done) break;
      }
      setStatus("idle");
    } catch (err) {
      if (err instanceof ProviderAuthError) setStatus("reauth", err.message);
      else setStatus("error", err instanceof Error ? err.message : String(err));
      console.error(`[slipstream] sync ${account.email}:`, err instanceof Error ? err.message : err);
    } finally {
      this.running.delete(accountId);
    }
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

    const from: Address = { name: account.name, email: account.email };
    const outgoing = await buildOutgoing({
      from,
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
