import { HttpError } from "../auth/users.ts";
import type { AppContext } from "../context.ts";
import type { Db } from "../db/index.ts";
import { compileClauses, NO_CODE_THREAD } from "./query.ts";
import { planRemote } from "./remote-query.ts";
import type { AccountRow } from "./store.ts";
import type { IncomingMessage, MailProvider } from "./types.ts";
import { threadsById } from "./views.ts";

/** The most results one account returns for one page. */
export const REMOTE_PAGE_MAX = 50;
/** How long one provider gets to answer before the search goes on without it. */
export const REMOTE_TIMEOUT_MS = 8_000;
/** An agent's text search reads at most this many unread-in-full messages to check them for codes. */
const AGENT_BODY_CHECK_MAX = 100;

export interface RemoteSearchOptions {
  q: string;
  /** Limit the search to one account id. */
  account?: string;
  /** `next` from the previous page. */
  pageToken?: string | null;
  /** Results per account for this page, up to REMOTE_PAGE_MAX. */
  limit?: number;
  /** The reader is an agent: it must never learn a one-time code. */
  hideCodes?: boolean;
  timeoutMs?: number;
}

export interface RemoteFailure {
  accountId: string;
  email: string;
  provider: string;
  /** A sentence a person can read. */
  error: string;
}

export interface RemoteSearchResult {
  threads: ReturnType<typeof threadsById>;
  /** Pass back as `pageToken` for more; null when every account has said all it has. */
  next: string | null;
  /** Accounts that couldn't be searched. The rest of the result stands. */
  failures: RemoteFailure[];
  /** The accounts that were asked. */
  searched: { accountId: string; email: string; provider: string }[];
  /** Operators in the search that only exist in Slipstream and were not sent to the provider. */
  localOnly: string[];
  /** Says so in words, when `localOnly` isn't empty. */
  note?: string;
}

class TimedOut extends Error {
  override name = "TimedOut";
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut("The provider took too long to answer")), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const encodeToken = (tokens: Record<string, string | null>) => Buffer.from(JSON.stringify(tokens)).toString("base64url");

function decodeToken(token: string | null | undefined): Record<string, string | null> | null {
  if (!token) return null;
  try {
    const o = JSON.parse(Buffer.from(token, "base64url").toString()) as Record<string, unknown>;
    if (o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every((v) => v === null || typeof v === "string")) return o as Record<string, string | null>;
  } catch {
    // falls through
  }
  throw new HttpError(400, "That search can't be continued; run it again");
}

/** The conversation a provider's message already belongs to here, by its id or its Message-ID. */
function knownThread(db: Db, accountId: string, m: IncomingMessage): string | null {
  const byId = db.get<{ thread_id: string }>(
    `SELECT m.thread_id FROM message_locations l JOIN messages m ON m.id = l.message_id WHERE l.account_id = ? AND l.remote_id = ?`,
    accountId,
    m.remoteId,
  );
  if (byId) return byId.thread_id;
  if (!m.messageIdHeader) return null;
  return db.get<{ thread_id: string }>("SELECT thread_id FROM messages WHERE account_id = ? AND message_id_header = ? LIMIT 1", accountId, m.messageIdHeader)?.thread_id ?? null;
}

/**
 * Stores what a provider search returned, as the sync would: new messages become regular conversations holding only their
 * summaries. A message Slipstream already has is left exactly as it is, so a search never undoes a change that is still on
 * its way to the provider. Returns the hits' conversations.
 */
async function store(ctx: AppContext, account: AccountRow, provider: MailProvider, messages: IncomingMessage[], timeoutMs: number): Promise<string[]> {
  const threadIds: string[] = [];
  const fresh: IncomingMessage[] = [];
  for (const m of messages) {
    const known = knownThread(ctx.db, account.id, m);
    if (known) threadIds.push(known);
    else fresh.push(m);
  }
  if (fresh.length === 0) return threadIds;
  // `done: false` and the account's own cursor: a search is not a sync pass and never moves where the next one resumes.
  const touched = ctx.store.ingest(account, { messages: fresh, cursor: account.sync_cursor, done: false });
  threadIds.push(...touched);
  if (provider.fetchPreviews) {
    try {
      const previews = await within(provider.fetchPreviews(fresh.map((m) => m.remoteId)), timeoutMs);
      ctx.db.tx(() => {
        for (const [remoteId, text] of previews) {
          const loc = ctx.db.get<{ message_id: string }>("SELECT message_id FROM message_locations WHERE account_id = ? AND remote_id = ?", account.id, remoteId);
          if (loc) ctx.store.attachPreview(loc.message_id, text);
        }
      });
    } catch (err) {
      // A missing preview only leaves a blank snippet until the conversation is opened.
      console.warn(`[slipstream] previews for ${account.email}:`, err instanceof Error ? err.message : err);
    }
  }
  ctx.events.emitToUser(account.user_id, { type: "threads", accountId: account.id, threadIds: touched });
  return threadIds;
}

/**
 * Searches a person's mail at each account's provider, stores the hits as summaries, and returns them as list rows.
 * One account failing or timing out is reported in `failures`; the others still answer.
 */
export async function searchRemote(ctx: AppContext, userId: string, opts: RemoteSearchOptions): Promise<RemoteSearchResult> {
  const now = Date.now();
  const timeoutMs = opts.timeoutMs ?? REMOTE_TIMEOUT_MS;
  const limit = Math.min(Math.max(opts.limit ?? REMOTE_PAGE_MAX, 1), REMOTE_PAGE_MAX);
  const plan = planRemote(opts.q, now);
  const localOnly = plan.localOnly;
  const note = localOnly.length ? `Not sent to the mail provider, so they only narrow what the provider found: ${localOnly.join(", ")}` : undefined;
  const nothing: RemoteSearchResult = { threads: [], next: null, failures: [], searched: [], localOnly, note };

  const mine = ctx.db.all<AccountRow>("SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at", userId);
  if (opts.account && !mine.some((a) => a.id === opts.account)) throw new HttpError(404, "Account not found");
  const tokens = decodeToken(opts.pageToken);
  const accounts = mine.filter(
    (a) =>
      a.provider !== "demo" &&
      a.provider !== "archive" &&
      (!opts.account || a.id === opts.account) &&
      (plan.accounts.length === 0 || plan.accounts.includes(a.email.toLowerCase())) &&
      (!tokens || a.id in tokens),
  );
  if (!plan.query || accounts.length === 0) return nothing;

  const query = plan.query;
  const outcomes = await Promise.all(
    accounts.map(async (account) => {
      const provider = ctx.sync.provider(account);
      if (!provider.search) return null;
      const token = tokens?.[account.id] ?? null;
      try {
        const res = await within(provider.search(query, { limit, pageToken: token ?? undefined }), timeoutMs);
        const threadIds = await store(ctx, account, provider, res.messages, timeoutMs);
        return { account, token, threadIds, next: res.next ?? null, error: null };
      } catch (err) {
        return { account, token, threadIds: [] as string[], next: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const asked = outcomes.filter((o) => o !== null);
  if (asked.length === 0) return nothing;

  const failures: RemoteFailure[] = asked
    .filter((o) => o.error !== null)
    .map((o) => ({ accountId: o.account.id, email: o.account.email, provider: o.account.provider, error: o.error! }));
  // An account that failed keeps the token it was asked with, so asking for more tries it again.
  const resume: Record<string, string | null> = {};
  for (const o of asked) {
    if (o.error !== null) resume[o.account.id] = o.token;
    else if (o.next) resume[o.account.id] = o.next;
  }

  const ids = [...new Set(asked.flatMap((o) => o.threadIds))];
  // What stayed on this machine (is:, label:, category:...) is checked against the stored summaries.
  const local = compileClauses(plan.local, now);
  const where = [local.where];
  const params = [...local.params];
  if (!local.scoped) where.push("t.in_trash = 0 AND t.in_spam = 0");
  if (opts.hideCodes && plan.hasText) {
    // The provider matched the words against whole messages, but a summary was only checked for codes in its preview. Read
    // the hits in full first, so the code check below sees everything the match could have; anything that can't be read is left out.
    const unread = ids.length
      ? ctx.db
          .all<{ id: string }>(`SELECT id FROM messages WHERE body_state = 'none' AND thread_id IN (${ids.map(() => "?").join(",")}) LIMIT ?`, ...ids, AGENT_BODY_CHECK_MAX)
          .map((r) => r.id)
      : [];
    if (unread.length) await within(ctx.sync.bodies.load(unread), timeoutMs).catch(() => undefined);
    where.push(NO_CODE_THREAD, "NOT EXISTS (SELECT 1 FROM messages pm WHERE pm.thread_id = t.id AND pm.body_state = 'none')");
  }
  const threads = threadsById(ctx, userId, ids, { where: where.join(" AND "), params }, { hideCodes: opts.hideCodes });

  return {
    threads,
    next: Object.keys(resume).length ? encodeToken(resume) : null,
    failures,
    searched: asked.map((o) => ({ accountId: o.account.id, email: o.account.email, provider: o.account.provider })),
    localOnly,
    note,
  };
}
