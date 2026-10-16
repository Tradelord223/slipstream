import type { Config } from "../config.ts";
import { parseHeaderBlock } from "../mail/mime.ts";
import { graphSearch } from "../mail/remote-query.ts";
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
  type ProviderQuery,
  type RemoteAction,
  type SyncPage,
  type SyncStageProgress,
} from "../mail/types.ts";
import { jsonBody, OAuthSession } from "./oauth.ts";

const ROOT = "https://graph.microsoft.com/v1.0";
const ME = `${ROOT}/me`;
const PAGE_SIZE = 100;
const BATCH_MAX = 20;
const ATTACHMENT_CONCURRENCY = 4;

const SELECT = [
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "replyTo",
  "receivedDateTime",
  "sentDateTime",
  "isRead",
  "flag",
  "conversationId",
  "internetMessageId",
  "internetMessageHeaders",
  "bodyPreview",
  "hasAttachments",
  "categories",
  "parentFolderId",
].join(",");

/** Well-known folders to mirror, and which Slipstream folder flag each one sets. */
const FOLDERS: { name: string; flag: keyof Folders | null }[] = [
  { name: "inbox", flag: "inbox" },
  { name: "sentitems", flag: "sent" },
  { name: "deleteditems", flag: "trash" },
  { name: "junkemail", flag: "spam" },
  { name: "archive", flag: null },
];

interface FolderState {
  /** Next page of an unfinished pass ("next") or the delta link to poll for changes ("delta"). */
  link?: string;
  kind?: "next" | "delta";
  /** The mailbox has no such folder (archive on some accounts). */
  missing?: true;
}

interface Cursor {
  folders: Record<string, FolderState>;
}

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  "@removed"?: { reason?: string };
  subject?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  bccRecipients?: GraphAddress[];
  replyTo?: GraphAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  conversationId?: string;
  internetMessageId?: string;
  parentFolderId?: string;
  /** Only when asked for in $select, and every header comes with it, so the few the summary needs are picked out. */
  internetMessageHeaders?: { name: string; value: string }[];
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  hasAttachments?: boolean;
  categories?: string[];
}

interface DeltaResponse {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

class GraphHttpError extends Error {
  override name = "GraphHttpError";
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function graphMessage(status: number, body: unknown): string {
  const e = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  return `Microsoft Graph: ${e?.message ?? `returned ${status}`} (${status}${e?.code ? ` ${e.code}` : ""})`;
}

function parseCursor(raw: string | null): Cursor {
  if (raw) {
    try {
      const c = JSON.parse(raw) as Partial<Cursor>;
      if (c.folders && typeof c.folders === "object") return { folders: c.folders };
    } catch {
      // Unreadable cursor: start over; the store dedupes by remote id.
    }
  }
  return { folders: {} };
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

/** The headers Graph's own fields don't carry; the rest of a summary comes from those fields. */
const LIST_HEADERS = new Set(["in-reply-to", "references", "list-unsubscribe", "list-id", "precedence", "auto-submitted"]);

const address = (a: GraphAddress) => ({ name: a.emailAddress?.name ?? "", email: (a.emailAddress?.address ?? "").toLowerCase() });

interface SubResult {
  status: number;
  body?: unknown;
}

export class GraphProvider implements MailProvider {
  readonly kind = "outlook" as const;

  private ctx: ProviderContext;
  private http: OAuthSession;
  /** The first sync's window start, fixed so the counts and the delta queries agree on it. */
  private since?: string;
  /** Messages the window holds beyond the inbox's first page, when Graph could count them. */
  private historyTotal?: number | null;

  constructor(ctx: ProviderContext, config?: Config) {
    this.ctx = ctx;
    this.http = new OAuthSession("microsoft", ctx, config);
  }

  /** Every request asks for stable ids, so a moved message keeps its remote id. */
  private async request(url: string, init: RequestInit = {}, prefer?: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Prefer", prefer ? `IdType="ImmutableId", ${prefer}` : 'IdType="ImmutableId"');
    return this.http.fetch(url, { ...init, headers });
  }

  private async json<T>(url: string, init: RequestInit = {}, prefer?: string): Promise<T> {
    const res = await this.request(url, init, prefer);
    const body = await jsonBody<T>(res);
    if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, body));
    return body as T;
  }

  // ---- sync ---------------------------------------------------------------

  async sync(cursorText: string | null): Promise<SyncPage> {
    const cursor = parseCursor(cursorText);
    const messages: IncomingMessage[] = [];
    const flagUpdates: FlagUpdate[] = [];
    const deleted: string[] = [];
    // A cursor with no folders is a brand new sync: its first inbox page is the "inbox ready" moment.
    const fresh = Object.keys(cursor.folders).length === 0;

    // A first pass over each folder goes one page per call; once every folder has a delta link, each is polled once.
    const unfinished = FOLDERS.find((f) => {
      const s = cursor.folders[f.name];
      return !s || (s.kind === "next" && !s.missing);
    });
    const polling = unfinished ? [unfinished] : FOLDERS.filter((f) => cursor.folders[f.name]?.kind === "delta");
    if (unfinished && !fresh) this.historyTotal ??= await this.countWindow();

    let handled = 0;
    for (const folder of polling) {
      const out = await this.deltaPage(folder, cursor.folders[folder.name]?.link ?? this.initialUrl(folder.name), cursor);
      messages.push(...out.messages);
      flagUpdates.push(...out.flagUpdates);
      deleted.push(...out.deleted);
      handled += out.handled;
    }
    const more = FOLDERS.some((f) => {
      const s = cursor.folders[f.name];
      return !s || s.kind === "next";
    });

    let progress: SyncStageProgress | undefined;
    if (unfinished && fresh) {
      this.historyTotal = undefined;
      this.inboxCount = handled;
      progress = { stage: "inbox", total: handled, count: handled, last: true };
    } else if (unfinished) {
      progress = { stage: "history", total: this.historyTotal ?? null, count: handled, last: !more };
    }
    return {
      messages,
      flagUpdates,
      deletedRemoteIds: deleted,
      cursor: JSON.stringify(cursor),
      done: !more,
      progress,
    };
  }

  /** How many messages the window holds across the folders, less the inbox's first page, which was reported as its own stage. */
  private async countWindow(): Promise<number | null> {
    try {
      const counts = await Promise.all(
        FOLDERS.map(async (f) => {
          const res = await this.request(`${ME}/mailFolders/${f.name}/messages?$filter=${enc(`receivedDateTime ge ${this.windowStart()}`)}&$count=true&$top=1&$select=id`);
          if (res.status === 404) return 0;
          const body = await jsonBody<{ "@odata.count"?: number }>(res);
          if (!res.ok || typeof body?.["@odata.count"] !== "number") throw new Error("no count");
          return body["@odata.count"];
        }),
      );
      return Math.max(0, counts.reduce((a, b) => a + b, 0) - this.inboxCount);
    } catch {
      // A count is only a nicety for the progress bar; without one the total stays unknown.
      return null;
    }
  }

  private inboxCount = 0;

  private windowStart(): string {
    this.since ??= new Date(Date.now() - this.ctx.initialSyncDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return this.since;
  }

  private initialUrl(folder: string): string {
    // Newest first, so the first page of the inbox is the mail a person most wants to see.
    return `${ME}/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${enc(`receivedDateTime ge ${this.windowStart()}`)}&$orderby=${enc("receivedDateTime desc")}`;
  }

  /** Reads one delta page of one folder and records where to continue in `cursor`. */
  private async deltaPage(
    folder: (typeof FOLDERS)[number],
    url: string,
    cursor: Cursor,
  ): Promise<{ messages: IncomingMessage[]; flagUpdates: FlagUpdate[]; deleted: string[]; handled: number }> {
    const empty = { messages: [], flagUpdates: [], deleted: [], handled: 0 };
    const res = await this.request(url, {}, `odata.maxpagesize=${PAGE_SIZE}`);
    const body = await jsonBody<DeltaResponse>(res);
    if (res.status === 404 && folder.name === "archive") {
      cursor.folders[folder.name] = { missing: true };
      return empty;
    }
    if (res.status === 410) {
      // The delta token expired: this folder starts over.
      delete cursor.folders[folder.name];
      return empty;
    }
    if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, body));

    const items = body?.value ?? [];
    const present = items.filter((m) => !m["@removed"]);
    const removed = items.filter((m) => m["@removed"]);

    const messages = await mapLimit(present, ATTACHMENT_CONCURRENCY, (m) => this.toIncoming(m, folder));
    const flagUpdates: FlagUpdate[] = [];
    const deleted: string[] = [];
    for (const r of removed) {
      if (folder.flag === null) continue;
      if (folder.flag !== "trash") {
        flagUpdates.push({ remoteId: r.id, folders: { [folder.flag]: false } });
        continue;
      }
      // Leaving Deleted Items means emptied or restored; only a message that no longer exists anywhere is a delete.
      if (await this.exists(r.id)) flagUpdates.push({ remoteId: r.id, folders: { trash: false } });
      else deleted.push(r.id);
    }

    if (body?.["@odata.nextLink"]) cursor.folders[folder.name] = { link: body["@odata.nextLink"], kind: "next" };
    else if (body?.["@odata.deltaLink"]) cursor.folders[folder.name] = { link: body["@odata.deltaLink"], kind: "delta" };
    else throw new Error("Microsoft Graph returned neither a next link nor a delta link");
    return { messages, flagUpdates, deleted, handled: items.length };
  }

  private async exists(id: string): Promise<boolean> {
    const res = await this.request(`${ME}/messages/${enc(id)}?$select=id`);
    if (res.status === 404) return false;
    if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, await jsonBody(res)));
    return true;
  }

  /** A summary: Graph's own fields, its 255 character preview, and the list headers; the body comes later. */
  private async toIncoming(m: GraphMessage, folder: (typeof FOLDERS)[number]): Promise<IncomingMessage> {
    const from = m.from ? address(m.from) : { name: "", email: "" };
    const folders: Folders = { inbox: false, sent: false, trash: false, spam: false };
    if (folder.flag) folders[folder.flag] = true;
    const received = Date.parse(m.receivedDateTime ?? "");
    const sentAt = Date.parse(m.sentDateTime ?? "");
    const lists = (m.internetMessageHeaders ?? []).filter((h) => LIST_HEADERS.has(h.name.toLowerCase())).map((h) => `${h.name}: ${h.value}`);
    const extra = lists.length ? await parseHeaderBlock(lists.join("\r\n"), { remoteId: m.id }) : undefined;
    return {
      remoteId: m.id,
      remoteThreadId: m.conversationId,
      messageIdHeader: m.internetMessageId,
      inReplyTo: extra?.inReplyTo,
      references: extra?.references,
      from,
      to: (m.toRecipients ?? []).map(address),
      cc: (m.ccRecipients ?? []).map(address),
      bcc: (m.bccRecipients ?? []).map(address),
      replyTo: m.replyTo?.[0] ? address(m.replyTo[0]).email : undefined,
      subject: m.subject ?? "",
      sentAt: Number.isNaN(sentAt) ? (Number.isNaN(received) ? Date.now() : received) : sentAt,
      snippet: m.bodyPreview,
      bodyText: m.bodyPreview ?? "",
      bodyComplete: false,
      unread: m.isRead === false,
      starred: m.flag?.flagStatus === "flagged",
      folders,
      labels: (m.categories ?? []).map((name) => ({ remoteId: `cat:${name}`, name })),
      listUnsubscribe: extra?.listUnsubscribe,
      bulk: extra?.bulk,
      // Ours means "in Sent Items" (aliases included), never "the From header says so": anyone can write a From.
      outgoing: folders.sent,
      attachments: m.hasAttachments ? await this.attachments(m.id) : [],
    };
  }

  /** Graph's ids for the folders a search hit can sit in, so a hit knows whether it is in the inbox, Sent Items, Deleted Items or Junk. */
  private folderIds?: Promise<Map<string, (typeof FOLDERS)[number]>>;

  private folderMap(): Promise<Map<string, (typeof FOLDERS)[number]>> {
    this.folderIds ??= (async () => {
      const map = new Map<string, (typeof FOLDERS)[number]>();
      // Drafts are never shown; their folder is marked so search can leave them out.
      const known = [...FOLDERS.filter((f) => f.flag), { name: "drafts", flag: null }];
      await Promise.all(
        known.map(async (f) => {
          const res = await this.request(`${ME}/mailFolders/${f.name}?$select=id`);
          if (res.status === 404) return;
          const body = await jsonBody<{ id?: string }>(res);
          if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, body));
          if (body?.id) map.set(body.id, f);
        }),
      );
      return map;
    })().catch((err) => {
      this.folderIds = undefined;
      throw err;
    });
    return this.folderIds;
  }

  /**
   * Graph's `$search` over every folder. It can't be combined with $orderby or $filter, and returns results already ordered by
   * date (up to 1,000), so neither is sent. A continuation token is Graph's `@odata.nextLink`, which comes back from the browser
   * and is fetched with the account's token, so it is only followed while it still points at this mailbox's messages.
   */
  async search(query: ProviderQuery, opts: { limit: number; pageToken?: string }): Promise<{ messages: IncomingMessage[]; next?: string }> {
    let url: string;
    if (opts.pageToken) {
      const link = URL.canParse(opts.pageToken) ? new URL(opts.pageToken) : null;
      if (!link || link.origin !== "https://graph.microsoft.com" || !link.pathname.startsWith("/v1.0/me/messages")) {
        throw new Error("That search can't be continued; run it again");
      }
      url = link.href;
    } else {
      const expression = graphSearch(query).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      url = `${ME}/messages?$search=${enc(`"${expression}"`)}&$top=${opts.limit}&$select=${SELECT}`;
    }
    const body = await this.json<DeltaResponse>(url);
    const folders = await this.folderMap();
    const hits = (body.value ?? []).flatMap((m) => {
      const folder = folders.get(m.parentFolderId ?? "") ?? { name: "other", flag: null };
      return folder.name === "drafts" ? [] : [{ m, folder }];
    });
    const messages = await mapLimit(hits, ATTACHMENT_CONCURRENCY, (h) => this.toIncoming(h.m, h.folder));
    return { messages, next: body["@odata.nextLink"] };
  }

  /** The whole message, for one that was synced as a summary. Graph lists every attachment, inline ones included. */
  async fetchBody(messageRemoteId: string): Promise<FullBody> {
    const m = await this.json<GraphMessage>(`${ME}/messages/${enc(messageRemoteId)}?$select=body,hasAttachments`);
    const html = m.body?.contentType?.toLowerCase() === "html";
    const content = m.body?.content ?? "";
    const attachments = m.hasAttachments || (html && /cid:/i.test(content)) ? await this.attachments(messageRemoteId) : [];
    return { text: html ? "" : content, html: html ? content : undefined, attachments };
  }

  private async attachments(messageId: string): Promise<IncomingAttachment[]> {
    const res = await this.request(`${ME}/messages/${enc(messageId)}/attachments?$select=id,name,contentType,size,isInline,contentId`);
    if (res.status === 404) return [];
    const body = await jsonBody<{
      value?: { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentId?: string | null }[];
    }>(res);
    if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, body));
    return (body?.value ?? []).map((a) => ({
      remoteId: a.id,
      filename: a.name ?? "attachment",
      mimeType: a.contentType ?? "application/octet-stream",
      size: a.size ?? 0,
      contentId: a.contentId ?? undefined,
      inline: Boolean(a.isInline),
    }));
  }

  // ---- actions ------------------------------------------------------------

  async apply(action: RemoteAction): Promise<{ remoteId?: string } | void> {
    if (action.kind === "send") return this.send(action.message);
    const ids = action.messages.map((m) => m.remoteId).filter((id) => !id.startsWith("sent:") && !id.startsWith("local:"));
    if (ids.length === 0) return;

    const move = (destination: string) => (id: string) => ({
      method: "POST",
      url: `/me/messages/${enc(id)}/move`,
      body: { destinationId: destination },
    });
    const patch = (body: unknown) => (id: string) => ({ method: "PATCH", url: `/me/messages/${enc(id)}`, body });

    let ops: { method: string; url: string; body?: unknown }[];
    switch (action.kind) {
      case "archive":
        ops = ids.map(move("archive"));
        break;
      case "unarchive":
      case "untrash":
      case "unspam":
        ops = ids.map(move("inbox"));
        break;
      case "trash":
        ops = ids.map(move("deleteditems"));
        break;
      case "spam":
        ops = ids.map(move("junkemail"));
        break;
      case "markRead":
        ops = ids.map(patch({ isRead: true }));
        break;
      case "markUnread":
        // Like Gmail and the local store: only the newest message (messages arrive oldest first).
        ops = ids.slice(-1).map(patch({ isRead: false }));
        break;
      case "star":
        ops = ids.map(patch({ flag: { flagStatus: "flagged" } }));
        break;
      case "unstar":
        ops = ids.map(patch({ flag: { flagStatus: "notFlagged" } }));
        break;
      case "addLabel":
      case "removeLabel": {
        const name = action.label.name.trim();
        const current = await this.run(ids.map((id) => ({ method: "GET", url: `/me/messages/${enc(id)}?$select=categories` })));
        const updates = ids.flatMap((id, i) => {
          const have = (current[i]?.body as { categories?: string[] } | undefined)?.categories ?? [];
          const has = have.some((c) => c.toLowerCase() === name.toLowerCase());
          if (action.kind === "addLabel" ? has : !has) return [];
          const next = action.kind === "addLabel" ? [...have, name] : have.filter((c) => c.toLowerCase() !== name.toLowerCase());
          return [patch({ categories: next })(id)];
        });
        ops = updates;
        break;
      }
    }
    if (ops.length) await this.run(ops);
  }

  /**
   * Runs one request per message: directly for one, in JSON $batch calls of 20 for more.
   * A message that no longer exists is skipped as long as something else succeeded.
   */
  private async run(ops: { method: string; url: string; body?: unknown }[]): Promise<SubResult[]> {
    const results: SubResult[] = [];
    if (ops.length === 1) {
      const op = ops[0]!;
      const res = await this.request(`${ROOT}${op.url}`, {
        method: op.method,
        headers: op.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: op.body === undefined ? undefined : JSON.stringify(op.body),
      });
      results.push({ status: res.status, body: await jsonBody(res) });
    } else {
      for (let i = 0; i < ops.length; i += BATCH_MAX) {
        const chunk = ops.slice(i, i + BATCH_MAX);
        const batch = await this.json<{ responses?: { id: string; status: number; body?: unknown }[] }>(`${ROOT}/$batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: chunk.map((op, j) => ({
              id: String(j),
              method: op.method,
              url: op.url,
              headers: {
                Prefer: 'IdType="ImmutableId"',
                ...(op.body === undefined ? {} : { "Content-Type": "application/json" }),
              },
              body: op.body,
            })),
          }),
        });
        const byId = new Map((batch.responses ?? []).map((r) => [r.id, r]));
        chunk.forEach((_, j) => {
          const r = byId.get(String(j));
          results.push({ status: r?.status ?? 500, body: r?.body });
        });
      }
    }

    const failed = results.filter((r) => r.status >= 400);
    const hard = failed.find((r) => r.status !== 404);
    if (hard) {
      if (hard.status === 401) throw new ProviderAuthError(graphMessage(hard.status, hard.body));
      throw new GraphHttpError(hard.status, graphMessage(hard.status, hard.body));
    }
    if (failed.length === results.length && failed.length > 0) throw new PermanentProviderError(graphMessage(404, failed[0]!.body));
    return results;
  }

  private async send(message: OutgoingMessage): Promise<Record<string, never>> {
    // Graph reads recipients, Bcc included, from the MIME itself. The copy in Sent Items syncs back and dedupes by Message-ID.
    const res = await this.request(`${ME}/sendMail`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: message.raw.toString("base64"),
    });
    if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, await jsonBody(res)));
    return {};
  }

  async fetchAttachment(messageRemoteId: string, attachmentRemoteId: string): Promise<Buffer> {
    const res = await this.request(`${ME}/messages/${enc(messageRemoteId)}/attachments/${enc(attachmentRemoteId)}/$value`);
    if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, await jsonBody(res)));
    return Buffer.from(await res.arrayBuffer());
  }
}
