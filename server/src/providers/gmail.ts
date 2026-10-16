import type { Config } from "../config.ts";
import { sanitizeOutgoingHtml } from "../lib/sanitize.ts";
import { decodeEntities } from "../lib/text.ts";
import { extractAttachment, parseHeaderBlock, parseRaw } from "../mail/mime.ts";
import {
  PermanentProviderError,
  ProviderAuthError,
  type FlagUpdate,
  type Folders,
  type FullBody,
  type IncomingAttachment,
  type IncomingMessage,
  type MailProvider,
  type OutgoingMessage,
  type ProviderContext,
  type ProviderIdentity,
  type RemoteAction,
  type SyncPage,
} from "../mail/types.ts";
import { jsonBody, OAuthSession } from "./oauth.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const LIST_PAGE = 500;
/** First-sync pages: small, so the dashboard sees mail after the first few requests and progress moves. */
const INITIAL_PAGE = 100;
const FETCH_CONCURRENCY = 8;
/** History pages read per sync call before handing control back to the engine. */
const HISTORY_PAGES_PER_CALL = 20;
const BATCH_MODIFY_MAX = 1000;
const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"];

/** Gmail system labels that never become Slipstream labels. User labels are the ones labels.list reports as type "user". */
const SYSTEM_LABELS = new Set(["INBOX", "SENT", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT", "CHAT", "DRAFT"]);
const isSystemLabel = (id: string) => SYSTEM_LABELS.has(id) || id.startsWith("CATEGORY_");

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  raw?: string;
  internalDate?: string;
  snippet?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

/**
 * What a summary asks Gmail for: format=full with a field mask that leaves out every byte of body data. The mask can't
 * pick headers by name, so the top-level headers come whole (a few KB) and are filtered here; the part tree is only
 * what attachments need (type, name, size, id, headers), nested as deep as real mail goes.
 */
const PART_FIELDS = "partId,mimeType,filename,headers(name,value),body(size,attachmentId)";
const nestedParts = (depth: number): string => (depth === 0 ? PART_FIELDS : `${PART_FIELDS},parts(${nestedParts(depth - 1)})`);
export const SUMMARY_FIELDS = `id,threadId,labelIds,snippet,sizeEstimate,internalDate,payload(mimeType,filename,headers(name,value),body(size,attachmentId),parts(${nestedParts(4)}))`;

/** The headers a summary keeps; everything else (Received, DKIM, ARC) is routing noise. */
const SUMMARY_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "in-reply-to", "references",
  "list-unsubscribe", "list-id", "precedence", "auto-submitted",
]);

interface GmailSendAs {
  sendAsEmail?: string;
  displayName?: string;
  replyToAddress?: string;
  signature?: string;
  isPrimary?: boolean;
  verificationStatus?: string;
}

interface HistoryRecord {
  messagesAdded?: { message: GmailMessage }[];
  messagesDeleted?: { message: GmailMessage }[];
  labelsAdded?: { message: GmailMessage }[];
  labelsRemoved?: { message: GmailMessage }[];
}

/** `historyId` is where incremental sync resumes; during paging it stays at the start of the range being read. */
interface Cursor {
  phase: "initial" | "incremental";
  historyId: string;
  pageToken?: string;
  /** The newest inbox mail has been handed over; what remains is the rest of the window. */
  top?: true;
  /** Gmail's estimate of the window's size, from the first list page, so progress keeps one total. */
  total?: number;
}

class GmailHttpError extends Error {
  override name = "GmailHttpError";
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function gmailError(res: Response): Promise<Error> {
  const body = await jsonBody<{ error?: { message?: string; errors?: { reason?: string }[] } }>(res);
  const reason = body?.error?.errors?.[0]?.reason ?? "";
  const message = body?.error?.message ?? `Gmail returned ${res.status}`;
  if (res.status === 403 && /insufficientPermissions|insufficient authentication scopes/i.test(`${reason} ${message}`)) {
    return new ProviderAuthError("Gmail access was not granted; sign in again and allow mail access");
  }
  // 429 and 403 rateLimitExceeded land here too: a plain error, so the engine retries later.
  return new GmailHttpError(res.status, `Gmail: ${message} (${res.status}${reason ? ` ${reason}` : ""})`);
}

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    if ((c.phase === "initial" || c.phase === "incremental") && typeof c.historyId === "string") return c as Cursor;
  } catch {
    // An unreadable cursor means starting over; the store dedupes by remote id.
  }
  return null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const enc = encodeURIComponent;

function withQuery(path: string, params: Record<string, string | number | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export class GmailProvider implements MailProvider {
  readonly kind = "gmail" as const;

  private ctx: ProviderContext;
  private http: OAuthSession;
  private labelCache: GmailLabel[] | null = null;
  /** Inbox mail the first sync has already fetched, so the rest of the window doesn't fetch it twice. */
  private handled = new Set<string>();

  constructor(ctx: ProviderContext, config?: Config) {
    this.ctx = ctx;
    this.http = new OAuthSession("google", ctx, config);
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http.fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await gmailError(res);
    return (await jsonBody<T>(res)) as T;
  }

  // ---- sync ---------------------------------------------------------------

  async sync(cursorText: string | null): Promise<SyncPage> {
    // Labels are re-read once per sync call, so labels created elsewhere show up without a restart.
    this.labelCache = null;
    const cursor = parseCursor(cursorText);
    if (!cursor) return this.initialPage(null);
    return cursor.phase === "initial" ? this.initialPage(cursor) : this.incremental(cursor);
  }

  private async initialPage(cursor: Cursor | null): Promise<SyncPage> {
    // Record the history position before listing, so mail arriving mid-sync is replayed by the first incremental pass.
    const historyId = cursor?.historyId ?? (await this.api<{ historyId: string }>("GET", "/profile")).historyId;
    return cursor?.top ? this.historyPage(cursor, historyId) : this.inboxPage(historyId);
  }

  /** The newest inbox mail in the window, first: this is all the dashboard needs to open. */
  private async inboxPage(historyId: string): Promise<SyncPage> {
    const list = await this.api<{ messages?: { id: string }[] }>(
      "GET",
      withQuery("/messages", { q: `in:inbox newer_than:${this.ctx.initialSyncDays}d`, maxResults: INITIAL_PAGE }),
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    const messages = await this.fetchSummaries(ids);
    this.handled = new Set(ids);
    return {
      messages,
      cursor: JSON.stringify({ phase: "initial", historyId, top: true }),
      done: false,
      progress: { stage: "inbox", total: ids.length, count: ids.length, last: true },
    };
  }

  /** The rest of the window, newest first. */
  private async historyPage(cursor: Cursor, historyId: string): Promise<SyncPage> {
    const list = await this.api<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
      "GET",
      withQuery("/messages", {
        q: `newer_than:${this.ctx.initialSyncDays}d -in:chats`,
        maxResults: INITIAL_PAGE,
        includeSpamTrash: "true",
        pageToken: cursor.pageToken,
      }),
    );
    const ids = (list.messages ?? []).map((m) => m.id);
    // Gmail's count is an estimate, and only the first page's is read, so the total stays put as the pages go by.
    const total = cursor.total ?? list.resultSizeEstimate ?? null;
    const messages = await this.fetchSummaries(ids.filter((id) => !this.handled.has(id)));
    const next = list.nextPageToken;
    return {
      messages,
      cursor: JSON.stringify(next ? { phase: "initial", historyId, top: true, pageToken: next, total: total ?? undefined } : { phase: "incremental", historyId }),
      done: !next,
      progress: { stage: "history", total, count: ids.length, last: !next },
    };
  }

  private async incremental(cursor: Cursor): Promise<SyncPage> {
    const added = new Set<string>();
    const deleted = new Set<string>();
    const changed = new Set<string>();
    let latest = cursor.historyId;
    let pageToken = cursor.pageToken;

    for (let pages = 0; pages < HISTORY_PAGES_PER_CALL; pages++) {
      let res: { history?: HistoryRecord[]; nextPageToken?: string; historyId?: string };
      try {
        res = await this.api("GET", withQuery("/history", { startHistoryId: cursor.historyId, historyTypes: HISTORY_TYPES, maxResults: LIST_PAGE, pageToken }));
      } catch (err) {
        // The start point is older than Gmail keeps history for (about a week): take a fresh snapshot.
        if (err instanceof GmailHttpError && err.status === 404) return this.initialPage(null);
        throw err;
      }
      for (const h of res.history ?? []) {
        for (const x of h.messagesAdded ?? []) added.add(x.message.id);
        for (const x of h.messagesDeleted ?? []) deleted.add(x.message.id);
        for (const x of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) changed.add(x.message.id);
      }
      if (res.historyId) latest = res.historyId;
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }

    const toFetch = [...added].filter((id) => !deleted.has(id));
    const toFlag = [...changed].filter((id) => !deleted.has(id) && !added.has(id));
    const messages = await this.fetchSummaries(toFetch);
    const flagUpdates = (await mapLimit(toFlag, FETCH_CONCURRENCY, (id) => this.fetchFlags(id))).filter((f): f is FlagUpdate => f !== null);

    return {
      messages,
      flagUpdates,
      deletedRemoteIds: [...deleted],
      cursor: JSON.stringify(
        pageToken ? { phase: "incremental", historyId: cursor.historyId, pageToken } : { phase: "incremental", historyId: latest },
      ),
      done: !pageToken,
    };
  }

  /** Fetches message summaries (headers, preview, attachment names). A message that vanished between listing and fetching is skipped. */
  private async fetchSummaries(ids: string[]): Promise<IncomingMessage[]> {
    const parsed = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
      let m: GmailMessage;
      try {
        m = await this.api<GmailMessage>("GET", withQuery(`/messages/${enc(id)}`, { format: "full", fields: SUMMARY_FIELDS }));
      } catch (err) {
        if (err instanceof GmailHttpError && err.status === 404) return null;
        throw err;
      }
      return this.toSummary(m);
    });
    return parsed.filter((m): m is IncomingMessage => m !== null);
  }

  private async fetchFlags(id: string): Promise<FlagUpdate | null> {
    let m: GmailMessage;
    try {
      m = await this.api<GmailMessage>("GET", withQuery(`/messages/${enc(id)}`, { format: "minimal" }));
    } catch (err) {
      if (err instanceof GmailHttpError && err.status === 404) return null;
      throw err;
    }
    if (isSkipped(m.labelIds)) return null;
    const { folders, unread, starred, labels } = await this.mapLabels(m.labelIds ?? []);
    return { remoteId: m.id, unread, starred, folders, labels };
  }

  private async toSummary(m: GmailMessage): Promise<IncomingMessage | null> {
    if (!m.payload || isSkipped(m.labelIds)) return null;
    const { folders, unread, starred, labels } = await this.mapLabels(m.labelIds ?? []);
    const head = (m.payload.headers ?? []).filter((h) => SUMMARY_HEADERS.has(h.name.toLowerCase())).map((h) => `${h.name}: ${h.value}`);
    const message = await parseHeaderBlock(head.join("\r\n"), {
      remoteId: m.id,
      remoteThreadId: m.threadId,
      folders,
      unread,
      starred,
      labels,
      selfEmail: this.ctx.email,
      receivedAt: m.internalDate ? Number(m.internalDate) : undefined,
    });
    // Ours means "carries the SENT label" (aliases included), never "the From header says so": anyone can write a From.
    message.outgoing = folders.sent;
    // Gmail's snippet is HTML-escaped text; it stands in for the body until the message is opened.
    message.bodyText = decodeEntities(m.snippet ?? "");
    message.bodyComplete = false;
    if (m.sizeEstimate) message.size = m.sizeEstimate;
    message.attachments = gmailAttachments(m.payload);
    return message;
  }

  private async mapLabels(labelIds: string[]): Promise<{ folders: Folders; unread: boolean; starred: boolean; labels: { remoteId: string; name: string }[] }> {
    const has = new Set(labelIds);
    const custom = labelIds.filter((id) => !isSystemLabel(id));
    const known = custom.length ? await this.labels() : [];
    const labels = custom.flatMap((id) => {
      const l = known.find((x) => x.id === id && x.type === "user");
      return l ? [{ remoteId: l.id, name: l.name }] : [];
    });
    return {
      folders: { inbox: has.has("INBOX"), sent: has.has("SENT"), trash: has.has("TRASH"), spam: has.has("SPAM") },
      unread: has.has("UNREAD"),
      starred: has.has("STARRED"),
      labels,
    };
  }

  private async labels(refresh = false): Promise<GmailLabel[]> {
    if (!this.labelCache || refresh) {
      this.labelCache = (await this.api<{ labels?: GmailLabel[] }>("GET", "/labels")).labels ?? [];
    }
    return this.labelCache;
  }

  /** Send-as aliases Gmail has verified. The primary address is the account itself, so it isn't one. */
  async listIdentities(): Promise<ProviderIdentity[]> {
    const res = await this.api<{ sendAs?: GmailSendAs[] }>("GET", "/settings/sendAs");
    return (res.sendAs ?? []).flatMap((s) => {
      const email = s.sendAsEmail?.trim();
      if (!email || s.isPrimary || email.toLowerCase() === this.ctx.email.toLowerCase()) return [];
      if (s.verificationStatus && s.verificationStatus !== "accepted") return [];
      return [
        {
          email,
          name: s.displayName?.trim() ?? "",
          replyTo: s.replyToAddress?.trim() || undefined,
          signatureHtml: s.signature ? sanitizeOutgoingHtml(s.signature) : undefined,
        },
      ];
    });
  }

  // ---- actions ------------------------------------------------------------

  async apply(action: RemoteAction): Promise<{ remoteId?: string } | void> {
    if (action.kind === "send") return this.send(action.message);
    try {
      await this.triage(action);
    } catch (err) {
      // Gmail answers 400/404 for a message or thread that's gone; retrying can't help.
      if (err instanceof GmailHttpError && (err.status === 400 || err.status === 404)) throw new PermanentProviderError(err.message);
      throw err;
    }
  }

  private async triage(action: Exclude<RemoteAction, { kind: "send" }>): Promise<void> {
    const ids = action.messages.map((m) => m.remoteId).filter((id) => !id.startsWith("sent:") && !id.startsWith("local:"));
    // Threads started locally carry a "ref:" id until the first sync learns Gmail's; act on their messages instead.
    const thread = action.threadRemoteId.startsWith("ref:") ? null : action.threadRemoteId;
    const modify = async (add: string[], remove: string[], only?: string[]) => {
      if (thread && !only) {
        await this.api("POST", `/threads/${enc(thread)}/modify`, { addLabelIds: add, removeLabelIds: remove });
        return;
      }
      const targets = only ?? ids;
      for (let i = 0; i < targets.length; i += BATCH_MODIFY_MAX) {
        await this.api("POST", "/messages/batchModify", { ids: targets.slice(i, i + BATCH_MODIFY_MAX), addLabelIds: add, removeLabelIds: remove });
      }
    };

    switch (action.kind) {
      case "archive":
        return modify([], ["INBOX"]);
      case "unarchive":
        return modify(["INBOX"], []);
      case "spam":
        return modify(["SPAM"], ["INBOX"]);
      case "unspam":
        return modify(["INBOX"], ["SPAM"]);
      case "markRead":
        return modify([], ["UNREAD"]);
      case "markUnread": {
        // Like the local store, mark only the newest message unread.
        const latest = await this.latestMessage(thread, ids);
        return latest ? modify(["UNREAD"], [], [latest]) : undefined;
      }
      case "star": {
        // Gmail stars are per message.
        const latest = await this.latestMessage(thread, ids);
        return latest ? modify(["STARRED"], [], [latest]) : undefined;
      }
      case "unstar":
        // Every message, so an older starred message can't star the thread again on the next sync.
        return modify([], ["STARRED"]);
      case "trash":
      case "untrash": {
        const verb = action.kind;
        if (thread) await this.api("POST", `/threads/${enc(thread)}/${verb}`);
        else await mapLimit(ids, FETCH_CONCURRENCY, (id) => this.api("POST", `/messages/${enc(id)}/${verb}`));
        // Gmail leaves a restored message out of the inbox; the local store puts it back.
        return verb === "untrash" ? modify(["INBOX"], []) : undefined;
      }
      case "addLabel":
      case "removeLabel": {
        const label = await this.resolveLabel(action.label, action.kind === "addLabel");
        if (!label) return;
        return action.kind === "addLabel" ? modify([label.id], []) : modify([], [label.id]);
      }
    }
  }

  /** The newest message of a thread, ignoring drafts. Gmail lists a thread's messages oldest first. */
  private async latestMessage(thread: string | null, ids: string[]): Promise<string | undefined> {
    if (!thread) return ids.at(-1);
    const t = await this.api<{ messages?: GmailMessage[] }>("GET", withQuery(`/threads/${enc(thread)}`, { format: "minimal" }));
    return t.messages?.findLast((m) => !m.labelIds?.includes("DRAFT"))?.id;
  }

  async renameLabel(label: { remoteId: string; name: string }, newName: string): Promise<void> {
    const found = await this.resolveLabel(label, false);
    if (!found) return;
    await this.api("PATCH", `/labels/${enc(found.id)}`, { name: newName });
    this.labelCache = null;
  }

  async deleteLabel(label: { remoteId: string; name: string }): Promise<void> {
    const found = await this.resolveLabel(label, false);
    if (!found) return;
    await this.api("DELETE", `/labels/${enc(found.id)}`);
    this.labelCache = null;
  }

  /** Finds a user label by id or name (names are case-insensitive in Gmail), creating it when asked. */
  private async resolveLabel(label: { remoteId: string; name: string }, create: boolean): Promise<GmailLabel | undefined> {
    const name = label.name.trim().toLowerCase();
    const find = (list: GmailLabel[]) =>
      list.find((l) => l.type === "user" && l.id === label.remoteId) ?? list.find((l) => l.type === "user" && l.name.toLowerCase() === name);
    const cached = find(await this.labels());
    if (cached) return cached;
    const fresh = find(await this.labels(true));
    if (fresh || !create) return fresh;
    try {
      const made = await this.api<GmailLabel>("POST", "/labels", {
        name: label.name.trim(),
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      });
      this.labelCache?.push({ ...made, type: "user" });
      return { ...made, type: "user" };
    } catch (err) {
      // Created elsewhere in the meantime.
      if (err instanceof GmailHttpError && err.status === 409) {
        const again = find(await this.labels(true));
        if (again) return again;
      }
      throw err;
    }
  }

  private async send(message: OutgoingMessage): Promise<{ remoteId: string }> {
    const body: { raw: string; threadId?: string } = { raw: message.raw.toString("base64url") };
    if (message.threadRemoteId && !message.threadRemoteId.startsWith("ref:")) body.threadId = message.threadRemoteId;
    const sent = await this.api<{ id: string }>("POST", "/messages/send", body);
    return { remoteId: sent.id };
  }

  /** The whole message, for one that was synced as a summary. */
  async fetchBody(messageRemoteId: string): Promise<FullBody> {
    const m = await this.api<GmailMessage>("GET", withQuery(`/messages/${enc(messageRemoteId)}`, { format: "raw" }));
    if (!m.raw) throw new Error("Gmail returned no message source");
    const { message } = await parseRaw(Buffer.from(m.raw, "base64url"), { remoteId: messageRemoteId });
    return { text: message.bodyText, html: message.bodyHtml, attachments: message.attachments };
  }

  async fetchAttachment(messageRemoteId: string, attachmentRemoteId: string): Promise<Buffer> {
    const m = await this.api<GmailMessage>("GET", withQuery(`/messages/${enc(messageRemoteId)}`, { format: "raw" }));
    if (!m.raw) throw new Error("Gmail returned no message source");
    return extractAttachment(Buffer.from(m.raw, "base64url"), attachmentRemoteId);
  }
}

/**
 * Attachments from the part tree: a part with a filename, or a non-text part Gmail stored separately (an inline image
 * with no name). The handle is the part id until the full message is fetched and brings its own.
 */
function gmailAttachments(root: GmailPart): IncomingAttachment[] {
  const out: IncomingAttachment[] = [];
  const header = (p: GmailPart, name: string) => p.headers?.find((h) => h.name.toLowerCase() === name)?.value;
  const walk = (p: GmailPart) => {
    const mime = p.mimeType ?? "application/octet-stream";
    const stored = Boolean(p.body?.attachmentId) && !/^(text\/(plain|html)|multipart\/)/i.test(mime);
    if (p.filename || stored) {
      const contentId = header(p, "content-id")?.replace(/^<|>$/g, "").trim() || undefined;
      out.push({
        remoteId: `part:${p.partId ?? out.length}`,
        filename: p.filename || "attachment",
        mimeType: mime,
        size: p.body?.size ?? 0,
        contentId,
        inline: /^\s*inline/i.test(header(p, "content-disposition") ?? "") && Boolean(contentId),
      });
      return;
    }
    for (const child of p.parts ?? []) walk(child);
  };
  for (const child of root.parts ?? []) walk(child);
  return out;
}

/** Drafts and Hangouts chat transcripts aren't mail Slipstream shows. */
function isSkipped(labelIds: string[] | undefined): boolean {
  return Boolean(labelIds?.includes("DRAFT") || labelIds?.includes("CHAT"));
}
