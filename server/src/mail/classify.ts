import type { Address } from "./types.ts";

/**
 * Where a conversation is sorted. "people" is shown as Important; the rest are Updates, Promotions, Social and Forums.
 * The old names (important, news, notification, other) still work as search words, see categoryAlias.
 */
export const CATEGORIES = ["people", "updates", "promotions", "social", "forums"] as const;
export type Category = (typeof CATEGORIES)[number];

export const isCategory = (v: string): v is Category => (CATEGORIES as readonly string[]).includes(v);

/** What each category is called on screen. */
export const CATEGORY_NAMES: Record<Category, string> = {
  people: "Important",
  updates: "Updates",
  promotions: "Promotions",
  social: "Social",
  forums: "Forums",
};

/** A search word for a category: the five names, plus the old ones. `other` means "anything that isn't people". */
export function categoryAlias(word: string): { is: Category } | { not: Category } | null {
  const w = word.toLowerCase();
  if (isCategory(w)) return { is: w };
  switch (w) {
    case "important": return { is: "people" };
    case "news": return { is: "promotions" };
    case "notification": return { is: "updates" };
    case "other": return { not: "people" };
    default: return null;
  }
}

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|system|updates?|news(letter)?s?|digest|marketing|promo(tions)?|deals|offers|info|hello|team|support|billing|receipts?|orders?|shipping|accounts?)([+._-].*)?$/i;

/**
 * Addresses a company's systems send account and service mail from. Such mail often carries an unsubscribe link, but it is
 * about the person's own accounts, not an offer. `info` is left out on purpose: small shops send their newsletters from it.
 */
const NOTIFICATION_LOCAL =
  /^(notifications?|notify|alerts?|billing|accounts?|orders?|statements?|updates|security|service|support)([+._-].*)?$/i;

const isNotificationSender = (email: string) => NOTIFICATION_LOCAL.test(email.split("@")[0] ?? "");

export function isAutomatedSender(addr: Address): boolean {
  const local = addr.email.split("@")[0] ?? "";
  return AUTOMATED_LOCAL.test(local);
}

// The no-reply family only (not notifications@, info@ ...). The web composer keeps a copy in web/src/lib/compose.ts.
const NO_REPLY_LOCAL = /^(no[-_]?reply|do[-_]?not[-_]?reply)\d*([+._-].*)?$/i;

/** An address that doesn't take replies: no-reply@, noreply2@, do_not_reply+tag@ ... */
export function isNoReplyAddress(email: string): boolean {
  const at = email.lastIndexOf("@");
  return at > 0 && NO_REPLY_LOCAL.test(email.slice(0, at));
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

/* ---------------------------------------------------------------- sorting */

/** What categorize reads from one message of the conversation. */
export interface CategoryMessage {
  outgoing: boolean;
  is_bulk: boolean;
  list_unsubscribe: string | null;
  /** The List-Id, lower case. */
  list_id: string | null;
  from_email: string;
  reply_to: string | null;
  subject: string;
  /** The registrable domain of the sender ('' when it has none). */
  sender_domain: string;
  /** Kinds of the message's signals: code, delivery, security, urgent. */
  signals: string[];
  /** Gmail's personal/promotions/social/updates/forums, or Outlook's personal (focused) and other. */
  provider_category: string | null;
}

/** What categorize needs to know about the person and their mailbox. */
export interface CategoryEnv {
  /** Who the provider is, for the words of a reason: "Gmail filed it under Promotions". */
  source: "gmail" | "outlook" | "mail";
  /** A contact the person starred as VIP (address in lower case). */
  vip: (email: string) => boolean;
  /** An address the person has sent mail to. */
  writtenTo: (email: string) => boolean;
  /** The person's corrections: pattern ('ana@shop.com', '@shop.com' or 'list:news.shop.com') to category. */
  rules: Map<string, Category>;
  /** For a correction an agent made, the agent's name by pattern; the others were made by the person. */
  ruleAgents?: Map<string, string>;
}

export interface Sorted {
  category: Category;
  /** `code` or `code:detail`, see REASONS. */
  reason: string;
}

/**
 * The reason codes and the sentence the web shows for each. The part after the colon is a detail: the correction's pattern,
 * the provider's category. Stored in threads.category_reason.
 */
export const REASONS: Record<string, string> = {
  replied: "You wrote in this conversation",
  vip: "From someone you starred as VIP",
  rule: "You moved mail from {detail} here",
  // The detail is the pattern, a space, then the name of the agent that made the correction.
  agent_rule: "{agent} moved mail from {detail} here",
  written_to: "You've written to them",
  provider: "{provider} filed it under {detail}",
  code: "It has a sign-in code",
  security: "It looks like a security alert",
  delivery: "It's a delivery update",
  receipt: "It looks like a receipt or order update",
  social: "From a social network",
  forum: "A mailing list discussion",
  notification: "Sent from a notification, billing or account address",
  unsubscribe: "It has an unsubscribe link",
  automated: "Sent from an automated address",
  list: "Sent through a mailing list",
  bulk: "Sent to many people at once",
  person: "It looks like it's from a person",
  legacy: "Sorted by an earlier version; it is sorted again soon",
};

const PROVIDER_WORDS: Record<string, string> = {
  personal: "Personal",
  promotions: "Promotions",
  social: "Social",
  updates: "Updates",
  forums: "Forums",
  other: "Other",
};

/** The sentence for a stored reason code, or null when there is none. */
export function reasonText(reason: string | null, source: CategoryEnv["source"] = "mail"): string | null {
  if (!reason) return null;
  const colon = reason.indexOf(":");
  const code = colon < 0 ? reason : reason.slice(0, colon);
  const detail = colon < 0 ? "" : reason.slice(colon + 1);
  const template = REASONS[code];
  if (!template) return null;
  if (code === "rule" && detail.startsWith("list:")) return "You moved this mailing list here";
  if (code === "agent_rule") {
    const space = detail.indexOf(" ");
    const pattern = space < 0 ? detail : detail.slice(0, space);
    const agent = space < 0 ? "" : detail.slice(space + 1);
    if (!agent) return null;
    return pattern.startsWith("list:") ? `${agent} moved this mailing list here` : template.replace("{agent}", agent).replace("{detail}", pattern.replace(/^@/, ""));
  }
  if (code === "provider") {
    const word = PROVIDER_WORDS[detail] ?? detail;
    const name = source === "gmail" ? "Gmail" : source === "outlook" ? "Outlook" : "Your mail provider";
    if (detail === "personal") return `${name} marked it ${source === "outlook" ? "Focused" : "Personal"}`;
    return template.replace("{provider}", name).replace("{detail}", word);
  }
  return template.replace("{detail}", detail.replace(/^@/, ""));
}

/** Networks whose mail is about people and posts rather than the person's own accounts. */
const SOCIAL_DOMAINS = new Set([
  "facebook.com", "facebookmail.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "pinterest.com", "reddit.com", "redditmail.com",
  "tiktok.com", "snapchat.com", "discord.com", "quora.com", "nextdoor.com", "meetup.com", "tumblr.com", "threads.net", "bsky.app",
  "mastodon.social", "strava.com", "goodreads.com",
]);

/** A receipt, invoice or order notice: transactional even when the sender adds an unsubscribe link. */
const RECEIPT_SUBJECT =
  /\b(receipt|invoice|order\s+(?:#|no\b|number|confirm|summary|status|update)|your\s+order|payment\s+(?:received|confirm|processed|failed|due)|purchase\s+confirm|booking\s+confirm|reservation\s+confirm|statement\s+is\s+ready|you(?:'|’)ve\s+been\s+charged|subscription\s+(?:renew|receipt))/i;

export const isReceiptSubject = (subject: string) => RECEIPT_SUBJECT.test(subject);

/** The part of an address after the last @, lower case. */
const hostOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Mail from a discussion list: it has a List-Id and its Reply-To is the list itself. Lists name themselves after their address
 * (dev@lists.example.org is `dev.lists.example.org`), which is how the Reply-To is matched to the List-Id.
 */
export function isForumMessage(m: Pick<CategoryMessage, "list_id" | "reply_to">): boolean {
  if (!m.list_id || !m.reply_to) return false;
  const at = m.reply_to.lastIndexOf("@");
  if (at < 1) return false;
  return m.list_id === `${m.reply_to.slice(0, at)}.${hostOf(m.reply_to)}`.toLowerCase();
}

/** The sort for one incoming message by its headers and wording alone, or null when it reads as a person's mail. */
function byPatterns(m: CategoryMessage): Sorted | null {
  const machine = m.is_bulk || isNoReplyAddress(m.from_email);
  if (!machine) return null;
  // Codes, sign-in alerts and deliveries are updates even from a social network.
  if (m.signals.includes("code")) return { category: "updates", reason: "code" };
  if (m.signals.includes("security")) return { category: "updates", reason: "security" };
  if (m.signals.includes("delivery")) return { category: "updates", reason: "delivery" };
  if (SOCIAL_DOMAINS.has(m.sender_domain)) return { category: "social", reason: "social" };
  if (isReceiptSubject(m.subject)) return { category: "updates", reason: "receipt" };
  if (isForumMessage(m)) return { category: "forums", reason: "forum" };
  // Account and service mail from a company's own systems stays in Updates even with an unsubscribe link.
  if (isNotificationSender(m.from_email)) return { category: "updates", reason: "notification" };
  if (m.list_unsubscribe) return { category: "promotions", reason: "unsubscribe" };
  if (isNoReplyAddress(m.from_email) || isAutomatedSender({ name: "", email: m.from_email })) return { category: "updates", reason: "automated" };
  return { category: "updates", reason: m.list_id ? "list" : "bulk" };
}

/** The correction that applies to this sender: the address first, then the mailing list, then the domain. */
function correction(m: CategoryMessage, env: CategoryEnv): Sorted | null {
  if (env.rules.size === 0) return null;
  const tries = [m.from_email, m.list_id ? `list:${m.list_id}` : "", m.sender_domain ? `@${m.sender_domain}` : ""];
  for (const pattern of tries) {
    const category = pattern ? env.rules.get(pattern) : undefined;
    if (!category) continue;
    const agent = env.ruleAgents?.get(pattern);
    return { category, reason: agent ? `agent_rule:${pattern} ${agent}` : `rule:${pattern}` };
  }
  return null;
}

/** The sort for one incoming message: the person's corrections, people they write to, the provider's own sorting, then patterns. */
function sortMessage(m: CategoryMessage, env: CategoryEnv): Sorted {
  const from = m.from_email.toLowerCase();
  if (env.vip(from)) return { category: "people", reason: "vip" };
  const fixed = correction(m, env);
  if (fixed) return fixed;
  if (!m.is_bulk && env.writtenTo(from)) return { category: "people", reason: "written_to" };

  const pc = m.provider_category;
  if (pc) {
    if (pc === "promotions" || pc === "social" || pc === "updates" || pc === "forums") return { category: pc, reason: `provider:${pc}` };
    // Personal mail counts as Important unless a machine sent it: receipts sit in Gmail's Primary tab too.
    const machine = m.is_bulk || isNoReplyAddress(m.from_email);
    if (pc === "personal" && !machine) return { category: "people", reason: "provider:personal" };
    // Outlook's Other holds what isn't Important, which includes people Outlook hasn't learned yet. It only says something when
    // the headers and wording agree, so anything that reads as a person's mail falls through to rule 6.
  }
  return byPatterns(m) ?? { category: "people", reason: "person" };
}

/**
 * The sort for a conversation, and why. The first rule that applies wins:
 *  1. you wrote in it, or a sender is someone you starred as VIP: people
 *  2. your correction for the sender, the mailing list or the domain
 *  3. a sender you have written to, unless it is bulk mail: people
 *  4. the provider's own sorting (Gmail's categories; Outlook's Focused is Important unless a machine sent it, and its Other adds nothing)
 *  5. headers and wording: social networks, codes and deliveries, receipts, discussion lists, account and service addresses,
 *     unsubscribe links
 *  6. anything else, from a person: people
 * Rules 2 to 6 sort each incoming message. A message that sorts as people makes the conversation people, as a human message
 * always did; otherwise the newest incoming message decides.
 */
export function categorize(messages: CategoryMessage[], env: CategoryEnv): Sorted {
  if (messages.some((m) => m.outgoing)) return { category: "people", reason: "replied" };
  const incoming = messages.filter((m) => !m.outgoing);
  if (incoming.length === 0) return { category: "people", reason: "person" };
  let newest: Sorted | null = null;
  for (let i = incoming.length - 1; i >= 0; i--) {
    const s = sortMessage(incoming[i]!, env);
    if (s.category === "people") return s;
    newest ??= s;
  }
  return newest!;
}
