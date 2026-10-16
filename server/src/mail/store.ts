import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.ts";
import { newId, sha256 } from "../lib/crypto.ts";
import { baseSubject, htmlToText, makeSnippet } from "../lib/text.ts";
import { categorize, isBulkMessage } from "./classify.ts";
import { ownAddresses } from "./identities.ts";
import { registrableDomain } from "./logos.ts";
import { orderSignals, scanSignals, type Signal } from "./signals.ts";
import type { Address, FlagUpdate, FullBody, IncomingAttachment, IncomingMessage, SyncPage, ThreadRef } from "./types.ts";

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
  /** When the account's first full sync finished; NULL until then. */
  first_synced_at: number | null;
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
  signals: string | null;
  created_at: number;
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
      if (page.done) for (const tid of this.purgeOrphans(account.id)) touched.add(tid);
      for (const tid of touched) this.recomputeThread(tid);
    });
    return [...touched];
  }

  private upsertMessage(account: AccountRow, m: IncomingMessage): string | null {
    // A message we sent is stored right away under a provisional id; adopt the provider's id when it syncs back.
    if (m.messageIdHeader && !m.remoteId.startsWith("sent:")) {
      const provisional = this.db.get<{ id: string; remote_id: string }>(
        "SELECT id, remote_id FROM messages WHERE account_id = ? AND message_id_header = ? AND remote_id LIKE 'sent:%'",
        account.id,
        m.messageIdHeader,
      );
      if (provisional) {
        this.db.run("UPDATE messages SET remote_id = ? WHERE id = ?", m.remoteId, provisional.id);
        this.db.run(
          "UPDATE message_locations SET remote_id = ? WHERE account_id = ? AND remote_id = ?",
          m.remoteId,
          account.id,
          provisional.remote_id,
        );
      }
    }

    // Known copy, or another copy of a message we already have (IMAP Inbox + Sent, a move between mailboxes).
    let existing = this.db.get<{ id: string; thread_id: string }>(
      `SELECT m.id, m.thread_id FROM message_locations l JOIN messages m ON m.id = l.message_id
       WHERE l.account_id = ? AND l.remote_id = ?`,
      account.id,
      m.remoteId,
    );
    if (!existing && m.messageIdHeader) {
      existing = this.db.get<{ id: string; thread_id: string }>(
        "SELECT id, thread_id FROM messages WHERE account_id = ? AND message_id_header = ? ORDER BY orphaned_at IS NOT NULL LIMIT 1",
        account.id,
        m.messageIdHeader,
      );
      if (existing) {
        this.db.run(
          "INSERT INTO message_locations (account_id, remote_id, message_id, inbox, trash, spam) VALUES (?,?,?,?,?,?)",
          account.id,
          m.remoteId,
          existing.id,
          m.folders.inbox ? 1 : 0,
          m.folders.trash ? 1 : 0,
          m.folders.spam ? 1 : 0,
        );
        // If the primary copy is gone (moved), this copy becomes the one actions and downloads use.
        this.db.run(
          `UPDATE messages SET orphaned_at = NULL, remote_id = CASE WHEN EXISTS (
             SELECT 1 FROM message_locations l WHERE l.account_id = messages.account_id AND l.remote_id = messages.remote_id
           ) THEN remote_id ELSE ? END WHERE id = ?`,
          m.remoteId,
          existing.id,
        );
      }
    }
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
      // One message in two mailboxes (a copy sent to yourself: Inbox first, Sent later): a Sent copy makes it ours.
      // Only ever raised, so a copy that isn't in Sent can't turn our own mail back into inbound.
      if (m.outgoing === true) this.db.run("UPDATE messages SET outgoing = 1, signals = '[]' WHERE id = ? AND outgoing = 0", existing.id);
      this.applyFlagUpdate(account.id, {
        remoteId: m.remoteId,
        unread: m.unread,
        starred: m.starred,
        folders: m.folders,
        labels: m.labels,
      });
      return existing.thread_id;
    }

    // Providers say whether a message is ours from where it lives (Sent folder or label), and that answer wins:
    // a From header is whatever the sender typed, so an inbound message From one of our aliases stays inbound.
    // Only a message the provider couldn't classify falls back to comparing the From with our own addresses.
    const outgoing = m.outgoing ?? ownAddresses(this.db, account.id).has(m.from.email.toLowerCase());
    const threadId = this.resolveThread(account.id, m);
    const bodyText = m.bodyText || (m.bodyHtml ? htmlToText(m.bodyHtml) : "");
    const snippet = m.snippet ? makeSnippet(m.snippet) : makeSnippet(bodyText);
    const isBulk = isBulkMessage({ from: m.from, bulk: m.bulk, listUnsubscribe: m.listUnsubscribe, outgoing });
    const signals = outgoing
      ? []
      : scanSignals({ subject: m.subject, fromEmail: m.from.email, fromName: m.from.name, text: bodyText, isBulk, sentAt: m.sentAt });
    const id = newId("msg");
    const now = Date.now();

    const res = this.db.run(
      `INSERT INTO messages (id, thread_id, account_id, remote_id, message_id_header, in_reply_to, refs,
        from_name, from_email, to_json, cc_json, bcc_json, reply_to, subject, sent_at, snippet, body_text, body_html,
        unread, starred, in_inbox, in_trash, in_spam, outgoing, list_unsubscribe, is_bulk, signals, created_at, sender_domain,
        body_state, size)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      json(signals),
      now,
      registrableDomain(m.from.email) ?? "",
      m.bodyComplete === false ? "none" : "cached",
      m.size ?? null,
    );

    this.db.run(
      "INSERT INTO message_locations (account_id, remote_id, message_id, inbox, trash, spam) VALUES (?,?,?,?,?,?)",
      account.id,
      m.remoteId,
      id,
      m.folders.inbox ? 1 : 0,
      m.folders.trash ? 1 : 0,
      m.folders.spam ? 1 : 0,
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
   * The first lines of a message that was stored as headers only. They become its snippet and its preview text, are indexed
   * for search and scanned for codes, and the thread is recomputed. A message that has its body by now (the full text wins),
   * or is gone, is left alone. Returns the message's thread, or null when nothing changed.
   */
  attachPreview(messageId: string, text: string): string | null {
    const preview = text.trim();
    if (!preview) return null;
    const m = this.db.get<{
      rowid: number;
      thread_id: string;
      subject: string;
      from_name: string;
      from_email: string;
      to_json: string;
      cc_json: string;
      is_bulk: number;
      outgoing: number;
      sent_at: number;
    }>("SELECT rowid, thread_id, subject, from_name, from_email, to_json, cc_json, is_bulk, outgoing, sent_at FROM messages WHERE id = ? AND body_state = 'none'", messageId);
    if (!m) return null;
    const signals = m.outgoing
      ? []
      : scanSignals({ subject: m.subject, fromEmail: m.from_email, fromName: m.from_name, text: preview, isBulk: Boolean(m.is_bulk), sentAt: m.sent_at });
    this.db.tx(() => {
      this.db.run("UPDATE messages SET snippet = ?, body_text = ?, signals = ? WHERE id = ?", makeSnippet(preview), preview, json(signals), messageId);
      // The search index is contentless: the old row goes by rowid and the preview takes its place.
      this.db.run("DELETE FROM messages_fts WHERE rowid = ?", m.rowid);
      this.db.run(
        "INSERT INTO messages_fts (rowid, subject, body, sender, recipients) VALUES (?,?,?,?,?)",
        m.rowid,
        m.subject,
        preview,
        `${m.from_name} ${m.from_email}`,
        [...(JSON.parse(m.to_json) as Address[]), ...(JSON.parse(m.cc_json) as Address[])].map((a) => `${a.name} ${a.email}`).join(" "),
      );
      this.recomputeThread(m.thread_id);
    });
    return m.thread_id;
  }

  /**
   * A message that was synced as a summary has now been fetched in full. Its preview gives way to the real text, which is
   * indexed for search and scanned again for codes and deliveries, and its attachment list is brought up to date.
   * Returns the message's thread, or null when the message is gone or already had its body.
   */
  attachBody(messageId: string, body: FullBody): string | null {
    const m = this.db.get<{
      rowid: number;
      thread_id: string;
      subject: string;
      from_name: string;
      from_email: string;
      to_json: string;
      cc_json: string;
      is_bulk: number;
      outgoing: number;
      sent_at: number;
      body_state: string;
    }>(
      "SELECT rowid, thread_id, subject, from_name, from_email, to_json, cc_json, is_bulk, outgoing, sent_at, body_state FROM messages WHERE id = ?",
      messageId,
    );
    if (!m || m.body_state === "cached") return null;
    const text = body.text || (body.html ? htmlToText(body.html) : "");
    const signals = m.outgoing
      ? []
      : scanSignals({ subject: m.subject, fromEmail: m.from_email, fromName: m.from_name, text, isBulk: Boolean(m.is_bulk), sentAt: m.sent_at });
    this.db.tx(() => {
      this.db.run(
        "UPDATE messages SET body_text = ?, body_html = ?, body_state = 'cached', signals = ? WHERE id = ?",
        text,
        body.html ?? null,
        json(signals),
        messageId,
      );
      // The search index is contentless: the old row goes by rowid and the full text takes its place.
      this.db.run("DELETE FROM messages_fts WHERE rowid = ?", m.rowid);
      this.db.run(
        "INSERT INTO messages_fts (rowid, subject, body, sender, recipients) VALUES (?,?,?,?,?)",
        m.rowid,
        m.subject,
        text.slice(0, 200_000),
        `${m.from_name} ${m.from_email}`,
        [...(JSON.parse(m.to_json) as Address[]), ...(JSON.parse(m.cc_json) as Address[])].map((a) => `${a.name} ${a.email}`).join(" "),
      );
      this.reconcileAttachments(messageId, body.attachments);
      this.recomputeThread(m.thread_id);
    });
    return m.thread_id;
  }

  /**
   * The summary pass stored attachment details the provider could give without the message (or none). The full message has
   * the real list: rows keep their ids (the dashboard holds them) and take the new handle; new ones are added; stale ones
   * the person never downloaded go.
   */
  private reconcileAttachments(messageId: string, incoming: IncomingAttachment[]): void {
    const rows = this.db.all<{ id: string; filename: string; mime_type: string; content_id: string | null; remote_id: string | null; blob_sha256: string | null }>(
      "SELECT id, filename, mime_type, content_id, remote_id, blob_sha256 FROM attachments WHERE message_id = ?",
      messageId,
    );
    const used = new Set<string>();
    const find = (a: IncomingAttachment) => {
      const free = rows.filter((r) => !used.has(r.id));
      return (
        free.find((r) => a.remoteId && r.remote_id === a.remoteId) ??
        free.find((r) => a.contentId && r.content_id === a.contentId) ??
        free.find((r) => r.filename === a.filename && r.mime_type === a.mimeType) ??
        free.find((r) => r.filename === a.filename)
      );
    };
    for (const a of incoming) {
      const blob = a.content ? this.saveBlob(a.content) : null;
      const size = a.size || a.content?.length || 0;
      const row = find(a);
      if (row) {
        used.add(row.id);
        this.db.run(
          "UPDATE attachments SET mime_type = ?, size = ?, content_id = ?, inline = ?, remote_id = ?, blob_sha256 = coalesce(?, blob_sha256) WHERE id = ?",
          a.mimeType,
          size,
          a.contentId ?? null,
          a.inline ? 1 : 0,
          a.remoteId ?? row.remote_id,
          blob,
          row.id,
        );
        continue;
      }
      this.db.run(
        `INSERT INTO attachments (id, message_id, filename, mime_type, size, content_id, inline, remote_id, blob_sha256)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        newId("att"),
        messageId,
        a.filename,
        a.mimeType,
        size,
        a.contentId ?? null,
        a.inline ? 1 : 0,
        a.remoteId ?? null,
        blob,
      );
    }
    for (const r of rows) if (!used.has(r.id) && !r.blob_sha256) this.db.run("DELETE FROM attachments WHERE id = ?", r.id);
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
      `SELECT m.id, m.thread_id FROM message_locations l JOIN messages m ON m.id = l.message_id
       WHERE l.account_id = ? AND l.remote_id = ?`,
      accountId,
      f.remoteId,
    );
    if (!msg) return null;
    const bit = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
    if (f.folders) {
      this.db.run(
        `UPDATE message_locations SET inbox = coalesce(?, inbox), trash = coalesce(?, trash), spam = coalesce(?, spam)
         WHERE account_id = ? AND remote_id = ?`,
        bit(f.folders.inbox),
        bit(f.folders.trash),
        bit(f.folders.spam),
        accountId,
        f.remoteId,
      );
      this.foldersFromLocations(msg.id);
    }
    this.db.run(
      "UPDATE messages SET unread = coalesce(?, unread), starred = coalesce(?, starred) WHERE id = ?",
      bit(f.unread),
      bit(f.starred),
      msg.id,
    );
    if (f.labels) this.setMessageLabels(accountId, msg.id, f.labels);
    return msg.thread_id;
  }

  /** A message is in a folder if any of its copies is. */
  private foldersFromLocations(messageId: string) {
    this.db.run(
      `UPDATE messages SET
         in_inbox = (SELECT max(inbox) FROM message_locations WHERE message_id = messages.id),
         in_trash = (SELECT max(trash) FROM message_locations WHERE message_id = messages.id),
         in_spam = (SELECT max(spam) FROM message_locations WHERE message_id = messages.id)
       WHERE id = ? AND EXISTS (SELECT 1 FROM message_locations WHERE message_id = messages.id)`,
      messageId,
    );
  }

  /**
   * One copy is gone. The message only goes away when no copies remain at the end of the sync round,
   * because a move between mailboxes shows up as a removal plus an addition, in either order.
   */
  private deleteMessage(accountId: string, remoteId: string): string | null {
    const msg = this.db.get<{ id: string; thread_id: string; remote_id: string }>(
      `SELECT m.id, m.thread_id, m.remote_id FROM message_locations l JOIN messages m ON m.id = l.message_id
       WHERE l.account_id = ? AND l.remote_id = ?`,
      accountId,
      remoteId,
    );
    if (!msg) return null;
    this.db.run("DELETE FROM message_locations WHERE account_id = ? AND remote_id = ?", accountId, remoteId);
    const other = this.db.get<{ remote_id: string }>("SELECT remote_id FROM message_locations WHERE message_id = ? LIMIT 1", msg.id);
    if (!other) {
      this.db.run("UPDATE messages SET orphaned_at = ? WHERE id = ?", Date.now(), msg.id);
    } else {
      if (msg.remote_id === remoteId) this.db.run("UPDATE messages SET remote_id = ? WHERE id = ?", other.remote_id, msg.id);
      this.foldersFromLocations(msg.id);
    }
    return msg.thread_id;
  }

  private purgeOrphans(accountId: string): string[] {
    const orphans = this.db.all<{ id: string; thread_id: string; rowid: number }>(
      "SELECT id, thread_id, rowid FROM messages WHERE account_id = ? AND orphaned_at IS NOT NULL",
      accountId,
    );
    for (const o of orphans) {
      this.db.run("DELETE FROM messages_fts WHERE rowid = ?", o.rowid);
      this.db.run("DELETE FROM messages WHERE id = ?", o.id);
    }
    return orphans.map((o) => o.thread_id);
  }

  /**
   * After a local triage change, write the messages' folder state through to their copies,
   * so a later sync of an untouched copy can't undo what the user did.
   */
  mirrorLocations(threadId: string): void {
    this.db.run(
      `UPDATE message_locations SET
         inbox = CASE WHEN m.in_inbox = 0 THEN 0 WHEN message_locations.remote_id = m.remote_id THEN 1 ELSE message_locations.inbox END,
         trash = m.in_trash,
         spam = m.in_spam
       FROM messages m WHERE m.id = message_locations.message_id AND m.thread_id = ?`,
      threadId,
    );
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
      last_inbound_at: number | null;
    }>("SELECT id, account_id, snoozed_until, reminded_at, muted, last_inbound_at FROM threads WHERE id = ?", threadId);
    if (!thread) return;
    const msgs = this.db.all<MessageAgg>(
      `SELECT m.id, from_name, from_email, to_json, cc_json, subject, sent_at, snippet, unread, starred, in_inbox, in_trash,
              in_spam, outgoing, is_bulk, list_unsubscribe, signals, m.created_at,
              EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.inline = 0) AS has_att
       FROM messages m WHERE thread_id = ? ORDER BY sent_at`,
      threadId,
    );
    if (msgs.length === 0) {
      this.db.run("DELETE FROM threads WHERE id = ?", threadId);
      return;
    }

    const own = ownAddresses(this.db, thread.account_id);
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
    let participants = [...seen.values()].filter((p) => !own.has(p.email));
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
    // The chips a list row shows come from the latest message someone sent us: all its signals, most important first.
    // A date from the future can't keep a chip fresh, so the time is the earlier of when it says it was sent and when it arrived.
    const latestIn = inbound.at(-1);
    const ordered = latestIn?.signals ? orderSignals(JSON.parse(latestIn.signals) as Signal[]) : [];
    const base = {
      signal: ordered.length ? json(ordered) : null,
      signal_at: ordered.length && latestIn ? Math.min(latestIn.sent_at, latestIn.created_at) : null,
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
          last_outbound_at=?, message_count=?, has_attachments=?, in_sent=?, category=?, sort_at=?, signal=?, signal_at=?, updated_at=? WHERE id=?`,
        base.subject, base.snippet, base.participants, base.first_message_at, base.last_message_at, base.last_inbound_at,
        base.last_outbound_at, base.message_count, base.has_attachments, base.in_sent, base.category, base.sort_at,
        base.signal, base.signal_at, Date.now(), threadId,
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

    // A new message from someone cancels a reminder: the thread is back because they wrote.
    // (Copies moving between mailboxes don't count; only genuinely newer inbound mail does.)
    let snoozed = thread.snoozed_until;
    const someoneWrote = lastInbound !== null && lastInbound > (thread.last_inbound_at ?? 0);
    if (snoozed && someoneWrote && inInbox) snoozed = null;
    // Muted threads never come back to the inbox on their own.
    const inboxFlag = inInbox && !thread.muted && !snoozed ? 1 : 0;

    this.db.run(
      `UPDATE threads SET subject=?, snippet=?, participants=?, first_message_at=?, last_message_at=?, last_inbound_at=?,
        last_outbound_at=?, message_count=?, unread_count=?, starred=?, in_inbox=?, in_trash=?, in_spam=?, has_attachments=?,
        in_sent=?, category=?, snoozed_until=?, sort_at=?, signal=?, signal_at=?, updated_at=? WHERE id=?`,
      base.subject, base.snippet, base.participants, base.first_message_at, base.last_message_at, base.last_inbound_at,
      base.last_outbound_at, base.message_count,
      msgs.reduce((n, m) => n + (m.unread ? 1 : 0), 0),
      msgs.some((m) => m.starred) ? 1 : 0,
      inboxFlag,
      msgs.every((m) => m.in_trash) ? 1 : 0,
      msgs.every((m) => m.in_spam) ? 1 : 0,
      base.has_attachments, base.in_sent, base.category, snoozed, base.sort_at, base.signal, base.signal_at, Date.now(), threadId,
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
