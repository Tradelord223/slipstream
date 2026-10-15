import type { Config } from "../config.ts";
import {
  PermanentProviderError,
  ProviderAuthError,
  type FlagUpdate,
  type Folders,
  type IncomingAttachment,
  type IncomingMessage,
  type MailProvider,
  type OutgoingMessage,
  type ProviderContext,
  type RemoteAction,
  type SyncPage,
} from "../mail/types.ts";
import { jsonBody, OAuthSession } from "./oauth.ts";

const ROOT = "https://graph.microsoft.com/v1.0";
const ME = `${ROOT}/me`;
const PAGE_SIZE = 50;
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
  "body",
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

const address = (a: GraphAddress) => ({ name: a.emailAddress?.name ?? "", email: (a.emailAddress?.address ?? "").toLowerCase() });

interface SubResult {
  status: number;
  body?: unknown;
}

export class GraphProvider implements MailProvider {
  readonly kind = "outlook" as const;

  private ctx: ProviderContext;
  private http: OAuthSession;

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

    // A first pass over each folder goes one page per call; once every folder has a delta link, each is polled once.
    const unfinished = FOLDERS.find((f) => {
      const s = cursor.folders[f.name];
      return !s || (s.kind === "next" && !s.missing);
    });
    const polling = unfinished ? [unfinished] : FOLDERS.filter((f) => cursor.folders[f.name]?.kind === "delta");

    for (const folder of polling) {
      const out = await this.deltaPage(folder, cursor.folders[folder.name]?.link ?? this.initialUrl(folder.name), cursor);
      messages.push(...out.messages);
      flagUpdates.push(...out.flagUpdates);
      deleted.push(...out.deleted);
    }
    const more = FOLDERS.some((f) => {
      const s = cursor.folders[f.name];
      return !s || s.kind === "next";
    });

    return {
      messages,
      flagUpdates,
      deletedRemoteIds: deleted,
      cursor: JSON.stringify(cursor),
      done: !more,
    };
  }

  private initialUrl(folder: string): string {
    const since = new Date(Date.now() - this.ctx.initialSyncDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return `${ME}/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${enc(`receivedDateTime ge ${since}`)}`;
  }

  /** Reads one delta page of one folder and records where to continue in `cursor`. */
  private async deltaPage(
    folder: (typeof FOLDERS)[number],
    url: string,
    cursor: Cursor,
  ): Promise<{ messages: IncomingMessage[]; flagUpdates: FlagUpdate[]; deleted: string[] }> {
    const empty = { messages: [], flagUpdates: [], deleted: [] };
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
    return { messages, flagUpdates, deleted };
  }

  private async exists(id: string): Promise<boolean> {
    const res = await this.request(`${ME}/messages/${enc(id)}?$select=id`);
    if (res.status === 404) return false;
    if (!res.ok) throw new GraphHttpError(res.status, graphMessage(res.status, await jsonBody(res)));
    return true;
  }

  private async toIncoming(m: GraphMessage, folder: (typeof FOLDERS)[number]): Promise<IncomingMessage> {
    const from = m.from ? address(m.from) : { name: "", email: "" };
    const html = m.body?.contentType?.toLowerCase() === "html";
    const content = m.body?.content ?? "";
    const folders: Folders = { inbox: false, sent: false, trash: false, spam: false };
    if (folder.flag) folders[folder.flag] = true;
    const received = Date.parse(m.receivedDateTime ?? "");
    const sentAt = Date.parse(m.sentDateTime ?? "");
    return {
      remoteId: m.id,
      remoteThreadId: m.conversationId,
      messageIdHeader: m.internetMessageId,
      from,
      to: (m.toRecipients ?? []).map(address),
      cc: (m.ccRecipients ?? []).map(address),
      bcc: (m.bccRecipients ?? []).map(address),
      replyTo: m.replyTo?.[0] ? address(m.replyTo[0]).email : undefined,
      subject: m.subject ?? "",
      sentAt: Number.isNaN(sentAt) ? (Number.isNaN(received) ? Date.now() : received) : sentAt,
      snippet: m.bodyPreview,
      bodyText: html ? "" : content,
      bodyHtml: html ? content : undefined,
      unread: m.isRead === false,
      starred: m.flag?.flagStatus === "flagged",
      folders,
      labels: (m.categories ?? []).map((name) => ({ remoteId: `cat:${name}`, name })),
      outgoing: from.email !== "" && from.email === this.ctx.email.toLowerCase(),
      attachments: m.hasAttachments ? await this.attachments(m.id) : [],
    };
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
