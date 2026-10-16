import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/index.ts";
import type { MailStore } from "./store.ts";

/**
 * The mail cache: the full text (and any downloaded attachment) of messages Slipstream can fetch again. Summaries are always
 * kept. Full text is kept for the newest inbox messages and for what was opened recently, up to a size limit per person;
 * past it, the least recently read bodies go back to being summaries and their attachment files are deleted.
 */

/** Newest inbox messages per account whose full text is always kept on hand. */
export const KEEP_INBOX = 50;
export const DEFAULT_CACHE_LIMIT_MB = 100;
/** Eviction stops here rather than at the limit, so the next message to arrive doesn't start another round. */
const EVICT_TO = 0.9;
/** A body that was just stored is left alone this long: its reader marks it as viewed a moment after it arrives. */
const FRESH_MS = 120_000;
/** The one-time trim keeps what was opened within this long. */
const OPENED_RECENTLY_MS = 7 * 86_400_000;
/** The database is compacted after the trim only when at least this much of the file is free space. */
export const COMPACT_MIN_BYTES = 50 * 1024 * 1024;

/**
 * Messages whose full text the provider can return again. Not these: mail imported from a file, the demo, a message we
 * sent that hasn't synced back (`sent:`) and one made locally (`local:`).
 */
const EVICTABLE = `m.account_id IN (SELECT id FROM accounts WHERE provider IN ('gmail', 'outlook', 'imap'))
  AND m.remote_id NOT LIKE 'sent:%' AND m.remote_id NOT LIKE 'local:%'`;
const OF_USER = "m.account_id IN (SELECT id FROM accounts WHERE user_id = ?)";

/** Runs a query and returns its rows; the doctor's read-only handle and `Db` both fit. */
export type Query = <T>(sql: string, ...params: SQLInputValue[]) => T[];

/** The newest inbox messages of an account, the ones whose full text is always kept (and that the recent cache fetches). */
export function newestInbox(query: Query, accountId: string, limit = KEEP_INBOX): { id: string; body_state: string }[] {
  return query<{ id: string; body_state: string }>(
    `SELECT id, body_state FROM messages
     WHERE account_id = ? AND in_inbox = 1 AND in_trash = 0 AND in_spam = 0 AND orphaned_at IS NULL
     ORDER BY sent_at DESC LIMIT ?`,
    accountId,
    limit,
  );
}

/** A person's size limit in bytes: their `cacheLimitMb` setting, else the default. */
export function limitBytes(query: Query, userId: string): number {
  const row = query<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = 'cacheLimitMb'", userId)[0];
  let mb = NaN;
  try {
    mb = row ? Number(JSON.parse(row.value)) : NaN;
  } catch {
    // An unreadable value is no value.
  }
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CACHE_LIMIT_MB) * 1024 * 1024;
}

export interface CacheUsage {
  /** Messages kept in full. */
  messages: number;
  /** Bytes of their text and HTML. */
  bodies: number;
  /** Bytes of attachment files that only these messages use. */
  blobs: number;
  total: number;
}

/**
 * What a person's cache holds. Computed, not counted as it changes: `octet_length` reads a column's size from the row's
 * header without loading its text, so this is cheap even for a large database and can't drift from the truth.
 */
export function cacheUsage(query: Query, blobDir: string, userId: string): CacheUsage {
  const sums = query<{ messages: number; bodies: number }>(
    `SELECT count(*) AS messages, coalesce(sum(octet_length(m.body_text) + coalesce(octet_length(m.body_html), 0)), 0) AS bodies
     FROM messages m WHERE m.body_state = 'cached' AND ${OF_USER} AND ${EVICTABLE}`,
    userId,
  )[0]!;
  // A file counts when every message that uses it is this person's and can be fetched again, and no draft or sender logo uses it.
  const shas = query<{ sha: string }>(
    `SELECT at.blob_sha256 AS sha FROM attachments at JOIN messages m ON m.id = at.message_id
     WHERE at.blob_sha256 IS NOT NULL
     GROUP BY at.blob_sha256
     HAVING min(${OF_USER} AND ${EVICTABLE}) = 1
       AND at.blob_sha256 NOT IN (SELECT blob_sha256 FROM draft_attachments)
       AND at.blob_sha256 NOT IN (SELECT blob_sha256 FROM sender_logos WHERE blob_sha256 IS NOT NULL)`,
    userId,
  );
  let blobs = 0;
  for (const { sha } of shas) {
    try {
      blobs += statSync(join(blobDir, sha.slice(0, 2), sha)).size;
    } catch {
      // The file is gone; nothing to count.
    }
  }
  return { messages: sums.messages, bodies: sums.bodies, blobs, total: sums.bodies + blobs };
}

export class CacheKeeper {
  private db: Db;
  private store: MailStore;
  private timer?: NodeJS.Timeout;
  /** Messages whose body was stored a moment ago, by id, until when they are left alone. */
  private fresh = new Map<string, number>();
  private trimming = false;

  constructor(db: Db, store: MailStore) {
    this.db = db;
    this.store = store;
  }

  private query: Query = (sql, ...params) => this.db.all(sql, ...params);

  usage(userId: string): CacheUsage {
    return cacheUsage(this.query, this.store.blobDir, userId);
  }

  /** Bodies were just stored: make room soon, once however many arrive together. */
  stored(ids: string[]): void {
    const until = Date.now() + FRESH_MS;
    for (const id of ids) this.fresh.set(id, until);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enforce();
    }, 1_000);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Bring every person's cache under their limit. A failure is logged; it never fails the sync or the read that triggered it.
   * While the one-time trim runs it does nothing: the trim does the same work in small steps, and this would do all of it at once.
   */
  enforce(): number {
    if (this.trimming || !this.db.raw.isOpen) return 0;
    let evicted = 0;
    for (const { user_id: userId } of this.db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM accounts")) {
      try {
        evicted += this.enforceFor(userId);
      } catch (err) {
        console.warn("[slipstream] mail cache:", err instanceof Error ? err.message : err);
      }
    }
    return evicted;
  }

  /** Messages that stay whole whatever the limit: the newest inbox mail of the person's accounts (everyone's when no person is named) and what just arrived. */
  private keepSet(userId?: string): Set<string> {
    const now = Date.now();
    for (const [id, until] of this.fresh) if (until <= now) this.fresh.delete(id);
    const keep = new Set(this.fresh.keys());
    const accounts = userId ? this.db.all<{ id: string }>("SELECT id FROM accounts WHERE user_id = ?", userId) : this.db.all<{ id: string }>("SELECT id FROM accounts");
    for (const a of accounts) for (const m of newestInbox(this.query, a.id)) keep.add(m.id);
    return keep;
  }

  private enforceFor(userId: string): number {
    const limit = limitBytes(this.query, userId);
    let size = this.usage(userId).total;
    if (size <= limit) return 0;

    const keep = this.keepSet(userId);
    // Least recently read first; a message nobody opened counts from when it was sent.
    const candidates = this.db
      .all<{ id: string; bytes: number }>(
        `SELECT m.id, octet_length(m.body_text) + coalesce(octet_length(m.body_html), 0) AS bytes FROM messages m
         WHERE m.body_state = 'cached' AND ${OF_USER} AND ${EVICTABLE}
         ORDER BY coalesce(m.last_viewed_at, m.sent_at), m.id`,
        userId,
      )
      .filter((c) => !keep.has(c.id));

    let evicted = 0;
    for (let i = 0; i < candidates.length && size > limit * EVICT_TO; i += 100) {
      const batch = [];
      for (const c of candidates.slice(i, i + 100)) {
        batch.push(c.id);
        size -= c.bytes;
        if (size <= limit * EVICT_TO) break;
      }
      size -= this.release(this.evict(batch));
      evicted += batch.length;
    }
    return evicted;
  }

  /**
   * Put messages back to summaries: the preview (the snippet) replaces the text, the HTML goes, the search index keeps the
   * preview, and attachment files let go. Returns the file hashes that were let go, for `release` once this has committed.
   */
  private evict(ids: string[]): Set<string> {
    const shas = new Set<string>();
    this.db.tx(() => {
      for (const id of ids) {
        const m = this.db.get<{ rowid: number; subject: string; from_name: string; from_email: string; to_json: string; cc_json: string; snippet: string }>(
          "SELECT rowid, subject, from_name, from_email, to_json, cc_json, snippet FROM messages WHERE id = ? AND body_state = 'cached'",
          id,
        );
        if (!m) continue;
        this.db.run("UPDATE messages SET body_state = 'none', body_text = snippet, body_html = NULL WHERE id = ?", id);
        // The search index is contentless: the old row goes by rowid and the preview takes its place.
        this.db.run("DELETE FROM messages_fts WHERE rowid = ?", m.rowid);
        const recipients = [...(JSON.parse(m.to_json) as { name: string; email: string }[]), ...(JSON.parse(m.cc_json) as { name: string; email: string }[])];
        this.db.run(
          "INSERT INTO messages_fts (rowid, subject, body, sender, recipients) VALUES (?,?,?,?,?)",
          m.rowid,
          m.subject,
          m.snippet,
          `${m.from_name} ${m.from_email}`,
          recipients.map((a) => `${a.name} ${a.email}`).join(" "),
        );
        for (const a of this.db.all<{ blob_sha256: string }>("SELECT blob_sha256 FROM attachments WHERE message_id = ? AND blob_sha256 IS NOT NULL", id)) shas.add(a.blob_sha256);
        // The attachment row stays; opening it loads the message again and downloads the file.
        this.db.run("UPDATE attachments SET blob_sha256 = NULL WHERE message_id = ?", id);
      }
    });
    return shas;
  }

  /** Delete attachment files nothing refers to any more. Returns the bytes freed. */
  private release(shas: Iterable<string>): number {
    let freed = 0;
    for (const sha of shas) {
      const used = this.db.get<{ x: number }>(
        `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM attachments WHERE blob_sha256 = ?1)
           OR EXISTS (SELECT 1 FROM draft_attachments WHERE blob_sha256 = ?1)
           OR EXISTS (SELECT 1 FROM sender_logos WHERE blob_sha256 = ?1)`,
        sha,
      );
      if (!used) freed += this.store.deleteBlob(sha);
    }
    return freed;
  }

  /**
   * Once per install: a database that grew under the old sync, which downloaded every message in full, goes back to the
   * cache's rules. Everything that can be fetched again turns back into a summary except the newest inbox messages and what
   * was opened in the last week; attachment files nothing refers to are deleted. It works in small batches, yielding
   * between them, and records itself only when it finished, so an interrupted run starts again. The usual limit applies
   * afterwards.
   */
  async trimOnce(opts: { batch?: number; signal?: AbortSignal; now?: number } = {}): Promise<{ ran: boolean; trimmed: number; files: number }> {
    const task = "trim-cache";
    if (this.trimming || this.db.get("SELECT 1 AS x FROM maintenance WHERE task = ?", task)) return { ran: false, trimmed: 0, files: 0 };
    const batch = opts.batch ?? 200;
    const openedAfter = (opts.now ?? Date.now()) - OPENED_RECENTLY_MS;

    let trimmed = 0;
    let files = 0;
    let after = -1;
    this.trimming = true;
    try {
      while (!opts.signal?.aborted) {
        // Walked by row number so a batch costs what it reads, however large the table is.
        const rows = this.db.all<{ rowid: number; id: string }>(
          `SELECT m.rowid AS rowid, m.id FROM messages m
           WHERE m.rowid > ? AND m.body_state = 'cached' AND ${EVICTABLE} AND coalesce(m.last_viewed_at, 0) < ?
           ORDER BY m.rowid LIMIT ?`,
          after,
          openedAfter,
          batch,
        );
        if (rows.length === 0) break;
        after = rows[rows.length - 1]!.rowid;
        // Looked up for each batch: the sync may be filling the newest inbox mail while this runs.
        const keep = this.keepSet();
        const ids = rows.map((r) => r.id).filter((id) => !keep.has(id));
        if (ids.length) {
          for (const sha of this.evict(ids)) if (this.release([sha])) files++;
          trimmed += ids.length;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (opts.signal?.aborted) return { ran: false, trimmed, files };
      files += this.sweepUnreferencedFiles();
    } finally {
      this.trimming = false;
    }
    this.enforce();
    this.db.run("INSERT OR REPLACE INTO maintenance (task, ran_at) VALUES (?, ?)", task, Date.now());
    return { ran: true, trimmed, files };
  }

  /** Attachment files on disk that no attachment, draft or sender logo refers to (left by removed accounts and old downloads). */
  private sweepUnreferencedFiles(): number {
    const dir = this.store.blobDir;
    if (!existsSync(dir)) return 0;
    const used = new Set(
      this.db
        .all<{ sha: string }>(
          `SELECT blob_sha256 AS sha FROM attachments WHERE blob_sha256 IS NOT NULL
           UNION SELECT blob_sha256 FROM draft_attachments
           UNION SELECT blob_sha256 FROM sender_logos WHERE blob_sha256 IS NOT NULL`,
        )
        .map((r) => r.sha),
    );
    let removed = 0;
    for (const sub of readdirSync(dir)) {
      for (const sha of readdirSync(join(dir, sub))) {
        if (!used.has(sha) && this.store.deleteBlob(sha) > 0) removed++;
      }
    }
    return removed;
  }

  /** Bytes of the database file that are free pages, which only a VACUUM gives back to the disk. */
  reclaimableBytes(): number {
    const pages = this.db.get<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count ?? 0;
    const size = this.db.get<{ page_size: number }>("PRAGMA page_size")?.page_size ?? 4096;
    return pages * size;
  }
}

/**
 * VACUUM in a worker thread on its own connection, so the server keeps answering. The server's reads go on; its writes wait
 * for the lock (up to the 5 s busy timeout), and the file needs free disk for a copy of what is left. The worker never keeps
 * the process alive, and an interrupted VACUUM leaves the database as it was.
 */
export function vacuumInBackground(dbPath: string): Promise<void> {
  const code = `
    const { workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    try {
      db.exec("PRAGMA busy_timeout = 60000");
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { path: dbPath } });
    worker.unref();
    worker.once("error", reject);
    worker.once("exit", (exitCode) => (exitCode === 0 ? resolve() : reject(new Error(`vacuum worker exited with ${exitCode}`))));
  });
}
