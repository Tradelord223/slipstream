import type { Account } from "../types.ts";

/** Accounts whose provider can search the whole mailbox. Demo data and imported archives have nothing beyond what is here. */
export const searchesAtProvider = (a: Account) => a.provider === "gmail" || a.provider === "outlook" || a.provider === "imap";

const PRESET_NAMES: Record<string, string> = {
  gmail: "Gmail",
  icloud: "iCloud Mail",
  fastmail: "Fastmail",
  yahoo: "Yahoo Mail",
  zoho: "Zoho Mail",
  proton: "Proton Mail",
};

/** What a person calls the place this account's mail lives. */
export function providerName(a: Account): string {
  if (a.provider === "gmail") return "Gmail";
  if (a.provider === "outlook") return "Outlook";
  return PRESET_NAMES[a.preset ?? ""] ?? a.email.split("@")[1] ?? "your mail server";
}

/** "Gmail", "Gmail and Outlook", "Gmail, Outlook and Fastmail". */
export function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length > 1 ? `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}` : (unique[0] ?? "");
}

/** Operators a provider can run for itself; the server makes the real split, this only spares a pointless wait. */
const SENT_KEYS = new Set(["from", "to", "subject", "after", "before", "newer", "older", "since", "until", "newer_than", "older_than"]);
const LOCAL_KEYS = new Set(["cc", "label", "category", "is", "in", "filename", "account"]);

/** Whether a search has free words or an operator that can go to the provider. */
export function sendsToProvider(q: string): boolean {
  const tokens = q.match(/(-?[a-z_]+:"[^"]*"|-?"[^"]*"|[^\s()]+)/gi) ?? [];
  return tokens.some((raw) => {
    if (raw === "OR" || raw === "AND" || raw === "|") return false;
    const t = raw.replace(/^-/, "");
    const colon = t.indexOf(":");
    const key = colon > 0 ? t.slice(0, colon).toLowerCase() : null;
    if (key === "has") return /^has:"?attachments?"?$/i.test(t);
    if (key && SENT_KEYS.has(key)) return true;
    if (key && LOCAL_KEYS.has(key)) return false;
    return t.replace(/"/g, "").length > 0;
  });
}
