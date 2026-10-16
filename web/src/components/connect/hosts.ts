import type { Account, Discovery } from "../../types.ts";

/** The ways a person can sign in. Zoho and Proton are reached by typing an address; the rest also have a tile. */
export type Kind = "gmail" | "outlook" | "icloud" | "yahoo" | "fastmail" | "zoho" | "proton" | "other";

export const KIND_NAME: Record<Kind, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  icloud: "iCloud",
  yahoo: "Yahoo",
  fastmail: "Fastmail",
  zoho: "Zoho Mail",
  proton: "Proton Mail",
  other: "another provider",
};

const DOMAINS: [Kind, RegExp][] = [
  ["gmail", /^(gmail|googlemail)\.com$/],
  ["outlook", /^(outlook|hotmail|live|msn)\.[a-z.]+$/],
  ["icloud", /^(icloud|me|mac)\.com$/],
  ["yahoo", /^(yahoo|ymail|rocketmail)\.[a-z.]+$/],
  ["fastmail", /^(fastmail\.(com|fm)|messagingengine\.com)$/],
  ["zoho", /^zoho(mail)?\.(com|eu|in)$/],
  ["proton", /^(proton\.me|protonmail\.(com|ch)|pm\.me)$/],
];

const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";

/** What we know about an address from its domain alone, when the server can't look it up. */
export function kindFromDomain(email: string): Kind | null {
  const domain = domainOf(email);
  return DOMAINS.find(([, re]) => re.test(domain))?.[0] ?? null;
}

export function kindFromDiscovery(d: Discovery): Kind {
  return d.provider === "imap" ? "other" : d.provider;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "jane.doe@example.com" becomes "Jane Doe". */
export function nameFromEmail(email: string): string {
  const local = email.trim().split("@")[0] ?? "";
  return local
    .split(/[._\-+\s]+/)
    .filter((part) => /[a-z]/i.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** A plain label for an account's provider. App-password accounts are stored as generic mail servers, so go by the address. */
export function providerLabel(a: Pick<Account, "provider" | "email">): string {
  switch (a.provider) {
    case "demo":
      return "Demo mailbox";
    case "archive":
      return "Imported archive";
    case "gmail":
      return "Gmail";
    case "outlook":
      return "Outlook";
  }
  const kind = kindFromDomain(a.email);
  return kind ? KIND_NAME[kind] : "Email account";
}

const OAUTH_ERRORS: Record<string, string> = {
  "google-not-configured": "Gmail sign-in isn't set up on this install yet.",
  "microsoft-not-configured": "Outlook sign-in isn't set up on this install yet.",
  expired: "That sign-in took too long. Try connecting again.",
  denied: "Connecting was cancelled.",
  access_denied: "Connecting was cancelled.",
};

/** What to tell someone whose Google or Microsoft sign-in came back with ?error=. */
export const oauthErrorText = (code: string) => OAUTH_ERRORS[code] ?? `Couldn't connect: ${code}`;

export const GUIDE_URL = "https://github.com/Tradelord223/slipstream/blob/main/docs/connect-accounts.md";
