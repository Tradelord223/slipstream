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

/** The consumer domains whose provider is certain from the name alone. Anything else needs the server's lookup. */
const WELL_KNOWN: Record<string, Kind> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
  "msn.com": "outlook",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "yahoo.com": "yahoo",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo",
  "fastmail.com": "fastmail",
  "fastmail.fm": "fastmail",
  "zoho.com": "zoho",
  "zohomail.com": "zoho",
  "proton.me": "proton",
  "protonmail.com": "proton",
  "protonmail.ch": "proton",
  "pm.me": "proton",
};

export const domainOf = (email: string) => email.trim().toLowerCase().split("@")[1] ?? "";

/** What we know about an address from its domain alone, when the server can't look it up. */
export function kindFromDomain(email: string): Kind | null {
  return WELL_KNOWN[domainOf(email)] ?? null;
}

/**
 * Which sign-in a lookup points to. Outlook is sign-in only, so it has no IMAP preset; every other named provider needs
 * one. A provider with no preset (Zoho's regional servers) is "other", with the servers the lookup found.
 */
export function kindFromDiscovery(d: Discovery): Kind {
  if (d.provider === "gmail" || d.provider === "outlook") return d.provider;
  return d.provider !== "imap" && d.preset ? d.provider : "other";
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

/** A plain label for an account's provider, from what was stored when it was connected, never guessed from the address. */
export function providerLabel(a: Pick<Account, "provider"> & { preset?: string | null }): string {
  switch (a.provider) {
    case "demo":
      return "Demo mailbox";
    case "archive":
      return "Imported archive";
  }
  const kind = [a.provider, a.preset].find((k): k is Kind => typeof k === "string" && k !== "other" && Object.hasOwn(KIND_NAME, k));
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
