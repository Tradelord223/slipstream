import type { Db } from "../db/index.ts";
import type { Events } from "../events.ts";
import type { AccountRow, MailStore } from "./store.ts";
import type { MailProvider } from "./types.ts";

/** How many messages are fetched from a provider at once for one request. */
const CONCURRENCY = 6;

interface Row {
  id: string;
  remote_id: string;
  message_id_header: string | null;
  account_id: string;
  body_state: string;
}

export interface BodyResult {
  /** Messages that are cached now (including ones that already were). */
  loaded: string[];
  failed: { id: string; error: string }[];
}

export interface LoadOptions {
  /** Messages fetched at once when the provider can only return them one by one. */
  concurrency?: number;
  /** Called once for every requested message as it settles, loaded or failed, so a caller can report exact progress. */
  onSettled?: (id: string) => void;
}

/** A plain sentence for a person; the provider's own wording is kept when it already is one. */
function reason(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text || "The provider didn't return this message";
}

/**
 * Brings the full text of messages that were synced as summaries. Everything that needs a body (opening a conversation,
 * an agent reading one, one-time codes, the recent cache) goes through here, so a message is never fetched twice at once.
 * A provider that can return many messages in one request (`fetchBodies`) is asked once per account; the others, one by one.
 */
export class BodyLoader {
  private inflight = new Map<string, Promise<string | null>>();

  private db: Db;
  private store: MailStore;
  private events: Events;
  private providerFor: (account: AccountRow) => MailProvider;
  private onStored?: (ids: string[]) => void;

  constructor(db: Db, store: MailStore, events: Events, providerFor: (account: AccountRow) => MailProvider, onStored?: (ids: string[]) => void) {
    this.db = db;
    this.store = store;
    this.events = events;
    this.providerFor = providerFor;
    this.onStored = onStored;
  }

  /** Makes sure each message has its body. A message that can't be fetched is reported, never thrown. */
  async load(ids: string[], opts: LoadOptions = {}): Promise<BodyResult> {
    const unique = [...new Set(ids)];
    const result: BodyResult = { loaded: [], failed: [] };
    if (unique.length === 0) return result;
    const rows = this.db.all<Row>(
      `SELECT id, remote_id, message_id_header, account_id, body_state FROM messages WHERE id IN (${unique.map(() => "?").join(",")})`,
      ...unique,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const todo: Row[] = [];
    for (const id of unique) {
      const row = byId.get(id);
      if (!row) result.failed.push({ id, error: "This message is no longer here" });
      else if (row.body_state === "cached") result.loaded.push(id);
      else {
        todo.push(row);
        continue;
      }
      opts.onSettled?.(id);
    }

    const threads = new Map<string, Set<string>>();
    const stored: string[] = [];
    const settle = (row: Row, p: Promise<string | null>) =>
      p
        .then(
          (threadId) => {
            result.loaded.push(row.id);
            stored.push(row.id);
            if (threadId) {
              const set = threads.get(row.account_id) ?? new Set<string>();
              set.add(threadId);
              threads.set(row.account_id, set);
            }
          },
          (err) => void result.failed.push({ id: row.id, error: reason(err) }),
        )
        .then(() => opts.onSettled?.(row.id));

    // Messages one request can serve together: an account's, unless someone is already fetching them.
    const groups = new Map<string, Row[]>();
    const singles: Row[] = [];
    const canBatch = new Map<string, boolean>();
    for (const row of todo) {
      if (!canBatch.has(row.account_id)) canBatch.set(row.account_id, Boolean(this.batchProvider(row.account_id)));
      if (this.inflight.has(row.id) || !canBatch.get(row.account_id)) singles.push(row);
      else groups.set(row.account_id, [...(groups.get(row.account_id) ?? []), row]);
    }
    const work: Promise<unknown>[] = [];
    for (const [accountId, group] of groups) {
      if (group.length < 2) singles.push(...group);
      else this.batch(accountId, group).forEach((p, i) => work.push(settle(group[i]!, p)));
    }
    let next = 0;
    const worker = async () => {
      while (next < singles.length) {
        const row = singles[next++]!;
        await settle(row, this.one(row));
      }
    };
    work.push(...Array.from({ length: Math.min(opts.concurrency ?? CONCURRENCY, singles.length) }, worker));
    await Promise.all(work);

    if (stored.length) this.onStored?.(stored);
    // Codes and deliveries found in the full text can change a row of the list.
    for (const [accountId, set] of threads) {
      const userId = this.db.get<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = ?", accountId)?.user_id;
      if (userId) this.events.emitToUser(userId, { type: "threads", accountId, threadIds: [...set] });
    }
    return result;
  }

  private account(accountId: string): AccountRow | undefined {
    return this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId);
  }

  /** The account's provider, when it can return several messages in one request. */
  private batchProvider(accountId: string): MailProvider | undefined {
    const account = this.account(accountId);
    const provider = account && this.providerFor(account);
    return provider?.fetchBodies ? provider : undefined;
  }

  private one(row: Row): Promise<string | null> {
    let p = this.inflight.get(row.id);
    if (!p) {
      p = this.fetch(row).finally(() => this.inflight.delete(row.id));
      this.inflight.set(row.id, p);
    }
    return p;
  }

  /**
   * One request for several of an account's messages. Each has its own `inflight` entry from the start, so a reader who
   * opens one of them meanwhile waits for this request instead of making another. They are stored one by one as the answer
   * is read; a message the provider left out fails alone, and a failed request fails each of them.
   */
  private batch(accountId: string, rows: Row[]): Promise<string | null>[] {
    const answer = this.batchProvider(accountId)!.fetchBodies!(rows.map((r) => ({ remoteId: r.remote_id, messageIdHeader: r.message_id_header })));
    return rows.map((row) => {
      const p = answer
        .then((bodies) => {
          const body = bodies.get(row.remote_id);
          if (!body) throw new Error("The message is no longer in this mailbox");
          return this.store.attachBody(row.id, body);
        })
        .finally(() => this.inflight.delete(row.id));
      this.inflight.set(row.id, p);
      return p;
    });
  }

  private async fetch(row: Row): Promise<string | null> {
    const account = this.account(row.account_id);
    if (!account) throw new Error("The account for this message was removed");
    const provider = this.providerFor(account);
    if (!provider.fetchBody) throw new Error("This account can't load full messages");
    const body = await provider.fetchBody(row.remote_id, { messageIdHeader: row.message_id_header });
    return this.store.attachBody(row.id, body);
  }
}
