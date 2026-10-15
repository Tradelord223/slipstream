import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.ts";
import { newId, sha256 } from "../lib/crypto.ts";
import { baseSubject, htmlToText, makeSnippet } from "../lib/text.ts";
import { categorize, isBulkMessage } from "./classify.ts";
import type { Address, FlagUpdate, IncomingMessage, SyncPage, ThreadRef } from "./types.ts";

export interface AccountRow {
  id: string;
  user_id: string;
  provider: string;
  email: string;
  name: string;
  color: string;
  auth_enc: string | null;
  sync_cursor: string | null;
  sync_status: string;
  sync_error: string | null;
  last_synced_at: number | null;
  created_at: number;
}

interface MessageAgg {
  id: string;
  from_name: string;
  from_email: string;
  to_json: string;
  cc_json: string;
  subject: string;
  sent_at: number;
  snippet: string;
  unread: number;
  starred: number;
  in_inbox: number;
  in_trash: number;
  in_spam: number;
  outgoing: number;
  is_bulk: number;
  list_unsubscribe: string | null;
  has_att: number;
}

const json = (v: unknown) => JSON.stringify(v);

/**
 * The local mail store. Providers hand it normalized pages; it threads them,
 * indexes them for search and keeps per-thread aggregates the UI reads directly.
 */
export class MailStore {
  private blobDir: string;

  readonly db: Db;

  constructor(db: Db, dataDir: string) {
    this.db = db;
    this.blobDir = join(dataDir, "blobs");
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
  }

  /** Apply one sync page. Returns the ids of threads whose list rows changed. */
  ingest(account: AccountRow, page: SyncPage): string[] {
    const touched = new Set<string>();
    this.db.tx(() => {
      for (const m of page.messages) {
        const tid = this.upsertMessage(account, m);
        if (tid) touched.add(tid);
      }
      for (const f of page.flagUpdates ?? []) {
        const tid = this.applyFlagUpdate(account.id, f);
        if (tid) touched.add(tid);
      }
      for (const rid of page.deletedRemoteIds ?? []) {
        const tid = this.deleteMessage(account.id, rid);
        if (tid) touched.add(tid);
      }
      for (const tid of touched) this.recomputeThread(tid);
    });
    return [...touched];
  }

  private upsertMessage(account: AccountRow, m: IncomingMessage): string | null {
    // A message we sent is stored right away under a provisional id; adopt the provider's id when it syncs back.
    if (m.messageIdHeader && !m.remoteId.startsWith("sent:")) {
      this.db.run(
        "UPDATE messages SET remote_id = ? WHERE account_id = ? AND message_id_header = ? AND remote_id LIKE 'sent:%'",
        m.remoteId,
        account.id,
        m.messageIdHeader,
      );
    }
    const existing = this.db.get<{ id: string; thread_id: string }>(
      "SELECT id, thread_id FROM messages WHERE account_id = ? AND remote_id = ?",
      account.id,
      m.remoteId,
    );
    if (existing) {
      // A thread we started locally learns its provider conversation id on the first sync back.
      if (m.remoteThreadId) {
        this.db.run(
          `UPDATE threads SET remote_id = ? WHERE id = ? AND remote_id LIKE 'ref:%'
             AND NOT EXISTS (SELECT 1 FROM threads WHERE account_id = ? AND remote_id = ?)`,
          m.remoteThreadId,
          existing.thread_id,
          account.id,
          m.remoteThreadId,
        );
      }
      this.applyFlagUpdate(account.id, {
        remoteId: m.remoteId,
        unread: m.unread,
        starred: m.starred,
        folders: m.folders,
        labels: m.labels,
      });
      return existing.thread_id;
    }

    // The same message can arrive twice through different folders (IMAP Sent + Inbox).
    if (m.messageIdHeader) {
      const dup = this.db.get<{ thread_id: string }>(
        "SELECT thread_id FROM messages WHERE account_id = ? AND message_id_header = ?",
        account.id,
        m.messageIdHeader,
      );
      if (dup && !m.remoteThreadId) return dup.thread_id;
    }

    const outgoing = m.outgoing ?? m.from.email.toLowerCase() === account.email.toLowerCase();
    const threadId = this.resolveThread(account.id, m);
    const bodyText = m.bodyText || (m.bodyHtml ? htmlToText(m.bodyHtml) : "");
    const snippet = m.snippet ? makeSnippet(m.snippet) : makeSnippet(bodyText);
    const isBulk = isBulkMessage({ from: m.from, bulk: m.bulk, listUnsubscribe: m.listUnsubscribe, outgoing });
    const id = newId("msg");
    const now = Date.now();

    const res = this.db.run(
      `INSERT INTO messages (id, thread_id, account_id, remote_id, message_id_header, in_reply_to, refs,
        from_name, from_email, to_json, cc_json, bcc_json, reply_to, subject, sent_at, snippet, body_text, body_html,
        unread, starred, in_inbox, in_trash, in_spam, outgoing, list_unsubscribe, is_bulk, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      threadId,
      account.id,
      m.remoteId,
      m.messageIdHeader ?? null,
      m.inReplyTo ?? null,
      m.references?.join(" ") ?? null,
      m.from.name,
      m.from.email.toLowerCase(),
      json(m.to),
      json(m.cc),
      json(m.bcc),
      m.replyTo ?? null,
      m.subject,
      m.sentAt,
      snippet,
      bodyText,
      m.bodyHtml ?? null,
      m.unread ? 1 : 0,
      m.starred ? 1 : 0,
      m.folders.inbox ? 1 : 0,
      m.folders.trash ? 1 : 0,
      m.folders.spam ? 1 : 0,
      outgoing ? 1 : 0,
      m.listUnsubscribe ?? null,
      isBulk ? 1 : 0,
      now,
    );

    this.db.run(
      "INSERT INTO messages_fts (rowid, subject, body, sender, recipients) VALUES (?,?,?,?,?)",
      res.lastInsertRowid,
      m.subject,
      bodyText.slice(0, 200_000),
      `${m.from.name} ${m.from.email}`,
      [...m.to, ...m.cc].map((a) => `${a.name} ${a.email}`).join(" "),
    );

    for (const a of m.attachments) {
      let blob: string | null = null;
      if (a.content) blob = this.saveBlob(a.content);
      this.db.run(
        `INSERT INTO attachments (id, message_id, filename, mime_type, size, content_id, inline, remote_id, blob_sha256)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        newId("att"),
        id,
        a.filename,
        a.mimeType,
        a.size || a.content?.length || 0,
        a.contentId ?? null,
        a.inline ? 1 : 0,
        a.remoteId ?? null,
        blob,
      );
    }

    if (m.labels) this.setMessageLabels(account.id, id, m.labels);
    this.recordContacts(account.id, m, outgoing);
    return threadId;
  }

  /**
   * Thread resolution: trust the provider's conversation id; otherwise follow
   * In-Reply-To/References to a message we already have; otherwise start a thread.
   */
  private resolveThread(accountId: string, m: IncomingMessage): string {
    let remoteThread = m.remoteThreadId;
    if (!remoteThread) {
      const refs = [m.inReplyTo, ...(m.references ?? [])].filter((r): r is string => Boolean(r));
      for (const ref of refs) {
        const hit = this.db.get<{ thread_id: string }>(
          "SELECT thread_id FROM messages WHERE account_id = ? AND message_id_header = ?",
          accountId,
          ref,
        );
        if (hit) return hit.thread_id;
      }
      remoteThread = `ref:${m.references?.[0] ?? m.inReplyTo ?? m.messageIdHeader ?? m.remoteId}`;
    }
    const found = this.db.get<{ id: string }>(
      "SELECT id FROM threads WHERE account_id = ? AND remote_id = ?",
      accountId,
      remoteThread,
    );
    if (found) return found.id;
    const id = newId("thr");
    this.db.run(
      "INSERT INTO threads (id, account_id, remote_id, subject, updated_at) VALUES (?,?,?,?,?)",
      id,
      accountId,
      remoteThread,
      baseSubject(m.subject),
      Date.now(),
    );
    return id;
  }

  private applyFlagUpdate(accountId: string, f: FlagUpdate): string | null {
    const msg = this.db.get<{ id: string; thread_id: string }>(
      "SELECT id, thread_id FROM messages WHERE account_id = ? AND remote_id = ?",
      accountId,
      f.remoteId,
    );
    if (!msg) return null;
    const sets: string[] = [];
    const params: (number | string)[] = [];
    const flag = (col: string, v: boolean | undefined) => {
      if (v === undefined) return;
      sets.push(`${col} = ?`);
      params.push(v ? 1 : 0);
    };
    flag("unread", f.unread);
    flag("starred", f.starred);
    flag("in_inbox", f.folders?.inbox);
    flag("in_trash", f.folders?.trash);
    flag("in_spam", f.folders?.spam);
    if (sets.length) this.db.run(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`, ...params, msg.id);
    if (f.labels) this.setMessageLabels(accountId, msg.id, f.labels);
    return msg.thread_id;
  }

  private deleteMessage(accountId: string, remoteId: string): string | null {
    const msg = this.db.get<{ id: string; thread_id: string; rowid: number }>(
      "SELECT id, thread_id, rowid FROM messages WHERE account_id = ? AND remote_id = ?",
      accountId,
      remoteId,
    );
    if (!msg) return null;
    this.db.run("DELETE FROM messages_fts WHERE rowid = ?", msg.rowid);
    this.db.run("DELETE FROM messages WHERE id = ?", msg.id);
    return msg.thread_id;
  }

  /** Records a message's full label set. Thread labels are rebuilt from these in recomputeThread. */
  private setMessageLabels(accountId: string, messageId: string, labels: { remoteId: string; name: string; color?: string }[]) {
    const ids: string[] = [];
    for (const l of labels) {
      let label = this.db.get<{ id: string }>(
        "SELECT id FROM labels WHERE account_id = ? AND (remote_id = ? OR (remote_id = ? AND lower(name) = lower(?)))",
        accountId,
        l.remoteId,
        `name:${l.name}`,
        l.name,
      );
      if (label) {
        // A label created locally by name learns its provider id here.
        this.db.run("UPDATE labels SET remote_id = ? WHERE id = ? AND remote_id LIKE 'name:%'", l.remoteId, label.id);
      } else {
        const id = newId("lbl");
        this.db.run(
          "INSERT INTO labels (id, account_id, remote_id, name, color) VALUES (?,?,?,?,?)",
          id,
          accountId,
          l.remoteId,
          l.name,
          l.color ?? null,
        );
        label = { id };
      }
      ids.push(label.id);
    }
    this.db.run("UPDATE messages SET label_ids = ? WHERE id = ?", JSON.stringify(ids), messageId);
  }

  private recordContacts(accountId: string, m: IncomingMessage, outgoing: boolean) {
    const upsert = (a: Address, sent: number, received: number) => {
      if (!a.email) return;
      this.db.run(
        `INSERT INTO contacts (account_id, email, name, sent_count, received_count, last_seen_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT (account_id, email) DO UPDATE SET
           name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
           sent_count = contacts.sent_count + excluded.sent_count,
           received_count = contacts.received_count + excluded.received_count,
           last_seen_at = MAX(contacts.last_seen_at, excluded.last_seen_at)`,
        accountId,
        a.email.toLowerCase(),
        a.name,
        sent,
        received,
        m.sentAt,
      );
    };
    if (outgoing) for (const a of [...m.to, ...m.cc, ...m.bcc]) upsert(a, 1, 0);
    else upsert(m.from, 0, 1);
  }

  /** Rebuild a thread's list-row aggregates from its messages. Deletes empty threads. */
  recomputeThread(threadId: string): void {
    const thread = this.db.get<{
      id: string;
      account_id: string;
      snoozed_until: number | null;
      reminded_at: number | null;
      muted: number;
    }>("SELECT id, account_id, snoozed_until, reminded_at, muted FROM threads WHERE id = ?", threadId);
    if (!thread) return;
    const msgs = this.db.all<MessageAgg>(
      `SELECT m.id, from_name, from_email, to_json, cc_json, subject, sent_at, snippet, unread, starred, in_inbox, in_trash,
              in_spam, outgoing, is_bulk, list_unsubscribe,
              EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.inline = 0) AS has_att
       FROM messages m WHERE thread_id = ? ORDER BY sent_at`,
      threadId,
    );
    if (msgs.length === 0) {
      this.db.run("DELETE FROM threads WHERE id = ?", threadId);
      return;
    }

    const account = this.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", thread.account_id);
    const self = account?.email.toLowerCase() ?? "";
    const first = msgs[0]!;
    const last = msgs[msgs.length - 1]!;
    const inbound = msgs.filter((m) => !m.outgoing);
    const outbound = msgs.filter((m) => m.outgoing);

    // Participants, most recent sender first, without the account owner unless they're alone.
    const seen = new Map<string, Address>();
    for (const m of [...msgs].reverse()) {
      const people: Address[] = [{ name: m.from_name, email: m.from_email }];
      if (m.outgoing) people.push(...(JSON.parse(m.to_json) as Address[]));
      for (const p of people) {
        const key = p.email.toLowerCase();
        if (key && !seen.has(key)) seen.set(key, { name: p.name, email: key });
      }
    }
    let participants = [...seen.values()].filter((p) => p.email !== self);
    if (participants.length === 0) participants = [...seen.values()];

    const known = (email: string) =>
      Boolean(
        this.db.get<{ x: number }>(
          "SELECT 1 AS x FROM contacts WHERE account_id = ? AND email = ? AND (sent_count > 0 OR vip = 1)",
          thread.account_id,
          email,
        ),
      );
    const category = categorize(
      msgs.map((m) => ({
        outgoing: Boolean(m.outgoing),
        is_bulk: Boolean(m.is_bulk),
        list_unsubscribe: m.list_unsubscribe,
        from_email: m.from_email,
      })),
      known,
    );

    // While a local triage action is waiting to reach the provider, the provider's view is stale:
    // keep the thread's triage flags as the user left them.
    const pending = this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM pending_actions
       WHERE status IN ('queued','running') AND json_extract(payload, '$.threadId') = ?`,
      threadId,
    );

    const inInbox = msgs.some((m) => m.in_inbox && !m.in_trash && !m.in_spam);
    const lastInbound = inbound.at(-1)?.sent_at ?? null;
    const sortAt = Math.max(last.sent_at, thread.reminded_at ?? 0);
    const base = {
      subject: baseSubject(first.subject) || baseSubject(last.subject),
      snippet: last.snippet,
      participants: json(participants.slice(0, 8)),
      first_message_at: first.sent_at,
      last_message_at: last.sent_at,
      last_inbound_at: lastInbound,
      last_outbound_at: outbound.at(-1)?.sent_at ?? null,
      message_count: msgs.length,
      has_attachments: msgs.some((m) => m.has_att) ? 1 : 0,
      in_sent: outbound.length > 0 ? 1 : 0,
      category,
      sort_at: sortAt,
    };

    if (pending && pending.n > 0) {
      this.db.run(
        `UPDATE threads SET subject=?, snippet=?, participants=?, first_message_at=?, last_message_at=?, last_inbound_at=?,
          last_outbound_at=?, message_count=?, has_attachments=?, in_sent=?, category=?, sort_at=?, updated_at=? WHERE id=?`,
        base.subject, base.snippet, base.participants, base.first_message_at, base.last_message_at, base.last_inbound_at,
        base.last_outbound_at, base.message_count, base.has_attachments, base.in_sent, base.category, base.sort_at,
        Date.now(), threadId,
      );
      return;
    }

    // Thread labels are the union of its messages' labels, when the provider reports labels at all.
    const labelSets = this.db
      .all<{ label_ids: string | null }>("SELECT label_ids FROM messages WHERE thread_id = ?", threadId)
      .filter((r) => r.label_ids !== null)
      .map((r) => JSON.parse(r.label_ids!) as string[]);
    if (labelSets.length > 0) {
      this.db.run("DELETE FROM thread_labels WHERE thread_id = ?", threadId);
      for (const id of new Set(labelSets.flat())) this.db.run("INSERT INTO thread_labels (thread_id, label_id) VALUES (?,?)", threadId, id);
    }

    // A new inbound message cancels a reminder (the thread is back because someone wrote).
    let snoozed = thread.snoozed_until;
    if (snoozed && inInbox) snoozed = null;
    // Muted threads never come back to the inbox on their own.
    const inboxFlag = inInbox && !thread.muted && !snoozed ? 1 : 0;

    this.db.run(
      `UPDATE threads SET subject=?, snippet=?, participants=?, first_message_at=?, last_message_at=?, last_inbound_at=?,
        last_outbound_at=?, message_count=?, unread_count=?, starred=?, in_inbox=?, in_trash=?, in_spam=?, has_attachments=?,
        in_sent=?, category=?, snoozed_until=?, sort_at=?, updated_at=? WHERE id=?`,
      base.subject, base.snippet, base.participants, base.first_message_at, base.last_message_at, base.last_inbound_at,
      base.last_outbound_at, base.message_count,
      msgs.reduce((n, m) => n + (m.unread ? 1 : 0), 0),
      msgs.some((m) => m.starred) ? 1 : 0,
      inboxFlag,
      msgs.every((m) => m.in_trash) ? 1 : 0,
      msgs.every((m) => m.in_spam) ? 1 : 0,
      base.has_attachments, base.in_sent, base.category, snoozed, base.sort_at, Date.now(), threadId,
    );
  }

  threadRef(threadId: string): ThreadRef & { accountId: string } {
    const t = this.db.get<{ remote_id: string; account_id: string }>(
      "SELECT remote_id, account_id FROM threads WHERE id = ?",
      threadId,
    );
    if (!t) throw new Error(`Unknown thread ${threadId}`);
    const messages = this.db.all<{ remoteId: string; messageIdHeader: string | null }>(
      "SELECT remote_id AS remoteId, message_id_header AS messageIdHeader FROM messages WHERE thread_id = ? AND remote_id NOT LIKE 'local:%' ORDER BY sent_at",
      threadId,
    );
    return { accountId: t.account_id, threadRemoteId: t.remote_id, messages };
  }

  saveBlob(content: Buffer): string {
    const hash = sha256(content);
    const path = join(this.blobDir, hash.slice(0, 2), hash);
    if (!existsSync(path)) {
      mkdirSync(join(this.blobDir, hash.slice(0, 2)), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    }
    return hash;
  }

  readBlob(hash: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const path = join(this.blobDir, hash.slice(0, 2), hash);
    return existsSync(path) ? readFileSync(path) : null;
  }
}
