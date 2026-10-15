import type { Address, Message, ThreadDetail } from "../types.ts";
import { quotableHtml } from "./emailHtml.ts";
import { displayName, escapeHtml, firstName } from "./format.ts";

export type ComposeKind = "new" | "reply" | "replyAll" | "forward";

export interface Seed {
  to: Address[];
  cc: Address[];
  subject: string;
  bodyHtml: string;
  replyToMessageId: string | null;
}

const longDate = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function parseAddress(raw: string): Address | null {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: (m[1] ?? "").trim(), email: m[2]!.trim().toLowerCase() };
  const plain = raw.trim().replace(/^<|>$/g, "");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plain) ? { name: "", email: plain.toLowerCase() } : null;
}

export function dedupe(list: Address[], exclude: Set<string> = new Set()): Address[] {
  const seen = new Set(exclude);
  const out: Address[] = [];
  for (const a of list) {
    const k = a.email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** The message a reply answers: the latest one from someone else, or the latest at all. */
export function replyTarget(messages: Message[], mine: Set<string>): Message {
  for (let i = messages.length - 1; i >= 0; i--) if (!mine.has(messages[i]!.from.email.toLowerCase())) return messages[i]!;
  return messages[messages.length - 1]!;
}

const prefix = (subject: string, re: RegExp, p: string) => (re.test(subject) ? subject : `${p} ${subject}`.trim());

function attribution(m: Message): string {
  return `On ${longDate.format(new Date(m.sentAt))}, ${escapeHtml(displayName(m.from))} &lt;${escapeHtml(m.from.email)}&gt; wrote:`;
}

export function buildSeed(detail: ThreadDetail, kind: ComposeKind, mine: Set<string>, signature: string): Seed {
  const target = replyTarget(detail.messages, mine);
  const subject = detail.thread.subject || target.subject;
  const sig = signature ? `<div class="ss-signature">${signature}</div>` : "";
  const quote = `<div class="ss-attr">${attribution(target)}</div><blockquote>${quotableHtml(target)}</blockquote>`;

  if (kind === "forward") {
    const header = `<div class="ss-attr">---------- Forwarded message ----------<br>From: ${escapeHtml(displayName(target.from))} &lt;${escapeHtml(target.from.email)}&gt;<br>Date: ${longDate.format(new Date(target.sentAt))}<br>Subject: ${escapeHtml(target.subject)}<br>To: ${target.to.map((a) => escapeHtml(a.email)).join(", ")}</div>`;
    return {
      to: [],
      cc: [],
      subject: prefix(subject, /^(fwd?|fw):/i, "Fwd:"),
      bodyHtml: `<div><br></div>${sig}${header}<blockquote>${quotableHtml(target)}</blockquote>`,
      replyToMessageId: target.id,
    };
  }

  const reply: Address[] = target.outgoing ? target.to : [target.replyTo ? (parseAddress(target.replyTo) ?? target.from) : target.from];
  let to = dedupe(reply, mine);
  let cc: Address[] = [];
  if (kind === "replyAll") {
    to = dedupe([...reply, ...target.to], mine);
    cc = dedupe(target.cc, new Set([...mine, ...to.map((a) => a.email.toLowerCase())]));
  }
  if (to.length === 0) to = reply;
  return {
    to,
    cc,
    subject: prefix(subject, /^re:/i, "Re:"),
    bodyHtml: `<div><br></div>${sig}${quote}`,
    replyToMessageId: target.id,
  };
}

export function newBody(signature: string): string {
  return `<div><br></div>${signature ? `<div class="ss-signature">${signature}</div>` : ""}`;
}

/** Replace {first_name}, {last_name} and {full_name}; other {placeholders} are wrapped so they stand out. */
export function fillSnippet(html: string, person: Address | undefined): string {
  const name = person?.name?.trim() || "";
  const full = name || (person ? firstName(person) : "");
  const parts = full.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]! : "";
  const known: Record<string, string> = { first_name: first, last_name: last, full_name: full };
  return html.replace(/\{([a-z_][a-z0-9_ ]*)\}/gi, (whole, key: string) => {
    const k = key.toLowerCase().replace(/ /g, "_");
    if (k in known) return known[k] ? escapeHtml(known[k]!) : `<span class="ss-ph">${escapeHtml(whole)}</span>`;
    return `<span class="ss-ph">${escapeHtml(whole)}</span>`;
  });
}

export function placeholdersLeft(html: string): number {
  return (html.match(/class="ss-ph"/g) ?? []).length;
}
