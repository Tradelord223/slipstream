import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { randomBytes } from "node:crypto";
import { htmlToText } from "../lib/text.ts";
import type { Address, OutgoingMessage } from "./types.ts";

const fmt = (a: Address) => (a.name ? { name: a.name, address: a.email } : a.email);

export interface ComposeInput {
  from: Address;
  replyTo?: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  inReplyTo?: string;
  references?: string[];
  threadRemoteId?: string;
  attachments?: { filename: string; mimeType: string; content: Buffer }[];
}

export async function buildOutgoing(input: ComposeInput): Promise<OutgoingMessage> {
  const domain = input.from.email.split("@")[1] || "slipstream.local";
  const messageIdHeader = `<${Date.now().toString(36)}.${randomBytes(9).toString("hex")}@${domain}>`;
  const text = htmlToText(input.html);
  const composer = new MailComposer({
    // Keep Bcc in the raw bytes: Gmail's API reads recipients from it (and strips it on delivery),
    // and the Sent copy should show who was Bcc'd. SMTP sends use the envelope instead.
    ...({ keepBcc: true } as object),
    from: fmt(input.from),
    replyTo: input.replyTo,
    to: input.to.map(fmt),
    cc: input.cc.map(fmt),
    bcc: input.bcc.map(fmt),
    subject: input.subject,
    html: wrapHtml(input.html),
    text,
    messageId: messageIdHeader,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments?.map((a) => ({ filename: a.filename, contentType: a.mimeType, content: a.content })),
    headers: { "X-Mailer": "Slipstream" },
  });
  const raw = await composer.compile().build();
  return {
    from: input.from,
    replyTo: input.replyTo,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text,
    inReplyTo: input.inReplyTo,
    references: input.references,
    threadRemoteId: input.threadRemoteId,
    attachments: input.attachments,
    raw,
    messageIdHeader,
  };
}

function wrapHtml(body: string): string {
  return `<!doctype html><html><body><div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">${body}</div></body></html>`;
}
