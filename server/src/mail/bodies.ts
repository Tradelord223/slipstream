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

/** A plain sentence for a person; the provider's own wording is kept when it already is one. */
function reason(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text || "The provider didn't return this message";
}

/**
 * Brings the full text of messages that were synced as summaries. Everything that needs a body (opening a conversation,
 * an agent reading one, one-time codes, the recent cache) goes through here, so a message is never fetched twice at once.
 */
export class BodyLoader {
  private inflight = new Map<string, Promise<string | null>>();

  private db: Db;
  private store: MailStore;
  private events: Events;
  private providerFor: (account: AccountRow) => MailProvider;

  constructor(db: Db, store: MailStore, events: Events, providerFor: (account: AccountRow) => MailProvider) {
    this.db = db;
    this.store = store;
    this.events = events;
    this.providerFor = providerFor;
  }

  /** Makes sure each message has its body. A message that can't be fetched is reported, never thrown. */
  async load(ids: string[], opts: { concurrency?: number } = {}): Promise<BodyResult> {
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
      else todo.push(row);
    }

    const threads = new Map<string, Set<string>>();
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const row = todo[next++]!;
        try {
          const threadId = await this.one(row);
          result.loaded.push(row.id);
          if (threadId) {
            const set = threads.get(row.account_id) ?? new Set<string>();
            set.add(threadId);
            threads.set(row.account_id, set);
          }
        } catch (err) {
          result.failed.push({ id: row.id, error: reason(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? CONCURRENCY, todo.length) }, worker));

    // Codes and deliveries found in the full text can change a row of the list.
    for (const [accountId, set] of threads) {
      const userId = this.db.get<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = ?", accountId)?.user_id;
      if (userId) this.events.emitToUser(userId, { type: "threads", accountId, threadIds: [...set] });
    }
    return result;
  }

  private one(row: Row): Promise<string | null> {
    let p = this.inflight.get(row.id);
    if (!p) {
      p = this.fetch(row).finally(() => this.inflight.delete(row.id));
      this.inflight.set(row.id, p);
    }
    return p;
  }

  private async fetch(row: Row): Promise<string | null> {
    const account = this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", row.account_id);
    if (!account) throw new Error("The account for this message was removed");
    const provider = this.providerFor(account);
    if (!provider.fetchBody) throw new Error("This account can't load full messages");
    const body = await provider.fetchBody(row.remote_id, { messageIdHeader: row.message_id_header });
    return this.store.attachBody(row.id, body);
  }
}
