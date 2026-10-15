import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { Address, Folders, IncomingMessage } from "./types.ts";

function addresses(field: AddressObject | AddressObject[] | undefined): Address[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  const out: Address[] = [];
  for (const group of list) {
    for (const a of group.value) {
      if (a.address) out.push({ name: a.name ?? "", email: a.address.toLowerCase() });
      for (const g of a.group ?? []) if (g.address) out.push({ name: g.name ?? "", email: g.address.toLowerCase() });
    }
  }
  return out;
}

function header(parsed: ParsedMail, name: string): string | undefined {
  const v = parsed.headers.get(name);
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "text" in v && typeof v.text === "string") return v.text;
  if (typeof v === "object" && "value" in v && typeof v.value === "string") return v.value;
  return String(v);
}

function listUnsubscribe(parsed: ParsedMail): string | undefined {
  const raw = parsed.headers.get("list-unsubscribe");
  if (!raw) return undefined;
  if (typeof raw === "string") return raw;
  // mailparser parses this header into { url, mail } objects
  const obj = raw as { url?: string; mail?: string };
  return [obj.url, obj.mail && `mailto:${obj.mail}`].filter(Boolean).join(", ") || undefined;
}

export interface ParseOptions {
  remoteId: string;
  remoteThreadId?: string;
  folders?: Partial<Folders>;
  unread?: boolean;
  starred?: boolean;
  labels?: { remoteId: string; name: string }[];
  /** Owner address; messages from it are marked outgoing. */
  selfEmail?: string;
  /** Fallback when the Date header is missing (e.g. IMAP INTERNALDATE). */
  receivedAt?: number;
  /** Keep attachment bytes on the message (imports). Otherwise only metadata is kept. */
  keepAttachmentContent?: boolean;
}

/** Parse RFC 5322 bytes into Slipstream's normalized message. */
export async function parseRawMessage(raw: Buffer | string, opts: ParseOptions): Promise<IncomingMessage> {
  return (await parseRaw(raw, opts)).message;
}

/** Like parseRawMessage, plus access to any raw header (e.g. Takeout's X-Gmail-Labels, X-GM-THRID). */
export async function parseRaw(
  raw: Buffer | string,
  opts: ParseOptions,
): Promise<{ message: IncomingMessage; header: (name: string) => string | undefined }> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, keepCidLinks: true });
  return { message: toIncoming(parsed, opts), header: (name) => header(parsed, name.toLowerCase()) };
}

/**
 * Attachment bytes by the index handle parseRaw assigns ("idx:N"). Providers that only keep raw
 * messages remotely (Gmail raw, IMAP) re-fetch the source and call this for downloads.
 */
export async function extractAttachment(raw: Buffer | string, remoteId: string): Promise<Buffer> {
  const index = Number(/^idx:(\d+)$/.exec(remoteId)?.[1] ?? NaN);
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, keepCidLinks: true });
  const att = parsed.attachments[index];
  if (!att) throw new Error("Attachment not found in message");
  return att.content;
}

function toIncoming(parsed: ParsedMail, opts: ParseOptions): IncomingMessage {
  const from = addresses(parsed.from)[0] ?? { name: "", email: "" };
  const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
  const precedence = header(parsed, "precedence")?.toLowerCase();
  const autoSubmitted = header(parsed, "auto-submitted")?.toLowerCase();
  const bulk =
    Boolean(header(parsed, "list-id")) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    (autoSubmitted !== undefined && autoSubmitted !== "no");
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const self = opts.selfEmail?.toLowerCase();

  return {
    remoteId: opts.remoteId,
    remoteThreadId: opts.remoteThreadId,
    messageIdHeader: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: refs,
    from,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    replyTo: addresses(parsed.replyTo)[0]?.email,
    subject: parsed.subject ?? "",
    sentAt: parsed.date?.getTime() ?? opts.receivedAt ?? Date.now(),
    bodyText: parsed.text ?? "",
    bodyHtml: html,
    unread: opts.unread ?? false,
    starred: opts.starred ?? false,
    folders: { inbox: false, sent: false, trash: false, spam: false, ...opts.folders },
    labels: opts.labels,
    listUnsubscribe: listUnsubscribe(parsed),
    bulk,
    outgoing: self ? from.email === self : undefined,
    attachments: parsed.attachments.map((a, i) => ({
      remoteId: `idx:${i}`,
      filename: a.filename ?? "attachment",
      mimeType: a.contentType,
      size: a.size,
      contentId: a.cid,
      inline: a.contentDisposition === "inline" && Boolean(a.cid),
      content: opts.keepAttachmentContent || (a.contentDisposition === "inline" && a.cid) ? a.content : undefined,
    })),
  };
}
