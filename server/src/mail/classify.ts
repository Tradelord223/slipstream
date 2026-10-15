import type { Address } from "./types.ts";

/**
 * Split rules. "Important" is mail from people; everything a machine sent goes to "Other",
 * subdivided into news (has an unsubscribe link) and notifications (automated, no unsubscribe).
 */
export type Category = "important" | "news" | "notification" | "other";

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|system|updates?|news(letter)?s?|digest|marketing|promo(tions)?|deals|offers|info|hello|team|support|billing|receipts?|orders?|shipping|accounts?)([+._-].*)?$/i;

export function isAutomatedSender(addr: Address): boolean {
  const local = addr.email.split("@")[0] ?? "";
  return AUTOMATED_LOCAL.test(local);
}

export interface ClassifyInput {
  from: Address;
  bulk?: boolean;
  listUnsubscribe?: string | null;
  outgoing?: boolean;
}

export function isBulkMessage(m: ClassifyInput): boolean {
  if (m.outgoing) return false;
  return Boolean(m.bulk || m.listUnsubscribe || isAutomatedSender(m.from));
}

/**
 * Thread category from its messages. A thread is important once a human wrote in it,
 * you replied in it, or the sender is someone you've emailed before (they're not bulk to you).
 */
export function categorize(
  messages: { outgoing: boolean; is_bulk: boolean; list_unsubscribe: string | null; from_email: string }[],
  knownCorrespondent: (email: string) => boolean,
): Category {
  let sawNews = false;
  for (const m of messages) {
    if (m.outgoing) return "important";
    if (!m.is_bulk) return "important";
    if (knownCorrespondent(m.from_email)) return "important";
    if (m.list_unsubscribe) sawNews = true;
  }
  if (messages.length === 0) return "other";
  return sawNews ? "news" : "notification";
}
