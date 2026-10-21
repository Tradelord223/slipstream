import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { htmlToText } from "../lib/text.ts";
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

/** mailparser files every List-* header under one "list" key: { unsubscribe: { url, mail }, id: { name } }. */
function listHeaders(parsed: ParsedMail): { unsubscribe?: { url?: string; mail?: string }; id?: unknown } {
  return (parsed.headers.get("list") ?? {}) as { unsubscribe?: { url?: string; mail?: string }; id?: unknown };
}

/**
 * The List-Id as lower case text without brackets: `<Dev.Lists.Example.org>` and a bare one both give the same id. The sender
 * writes it and searches are built from it, so anything but letters, digits and . - _ + is not a list id at all.
 */
function listId(parsed: ParsedMail): string | undefined {
  const id = listHeaders(parsed).id as { id?: unknown; name?: unknown } | undefined;
  // With a display name mailparser files the id under `id`; a lone <id> or bare text lands under `name`.
  const raw = typeof id?.id === "string" ? id.id : typeof id?.name === "string" ? id.name : "";
  const clean = raw.replace(/[<>\s]/g, "").toLowerCase();
  return /^[a-z0-9._+-]+$/.test(clean) ? clean : undefined;
}

function listUnsubscribe(parsed: ParsedMail): string | undefined {
  const obj = listHeaders(parsed).unsubscribe;
  if (!obj) return undefined;
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
 * A message a provider sent as headers only (the summaries-first sync). The header block goes through the same parser
 * as a full message, so addresses, dates and the list headers read exactly as they will once the body arrives.
 */
export async function parseHeaderBlock(headers: Buffer | string, opts: ParseOptions): Promise<IncomingMessage> {
  const text = (Buffer.isBuffer(headers) ? headers.toString("utf8") : headers).replace(/\s+$/, "");
  return (await parseRaw(Buffer.from(`${text}\r\n\r\n`, "utf8"), opts)).message;
}

/** The preview of a message from the first bytes of one MIME part: undo its transfer encoding and charset, then strip markup. */
export function previewFromPart(data: Buffer, part: { type: string; encoding?: string; charset?: string }, max = 2000): string {
  let bytes = data;
  const encoding = part.encoding?.toLowerCase();
  if (encoding === "base64") {
    const b64 = data.toString("latin1").replace(/[^A-Za-z0-9+/]/g, "");
    bytes = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), "base64");
  } else if (encoding === "quoted-printable") {
    const qp = data
      .toString("latin1")
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    bytes = Buffer.from(qp, "latin1");
  }
  let text: string;
  try {
    text = new TextDecoder(part.charset || "utf-8").decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  // The fetch stopped mid-character: a replacement mark at the very end isn't in the message.
  text = text.replace(/�$/, "");
  if (/^text\/html$/i.test(part.type)) text = htmlToText(text);
  return text.replace(/\r\n?/g, "\n").trim().slice(0, max);
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
    Boolean(listHeaders(parsed).id) ||
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
    listId: listId(parsed),
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
