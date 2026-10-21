import type { Category, Counts, Split } from "../types.ts";

/** The five places mail is sorted to, in menu order. `people` is shown as Important. */
export const CATEGORIES: { id: Category; name: string }[] = [
  { id: "people", name: "Important" },
  { id: "updates", name: "Updates" },
  { id: "promotions", name: "Promotions" },
  { id: "social", name: "Social" },
  { id: "forums", name: "Forums" },
];

export const categoryName = (c: Category): string => CATEGORIES.find((x) => x.id === c)?.name ?? c;

/** Providers that give people personal mailboxes. A correction can't name these as a company, so the menu doesn't offer it. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "hey.com", "fastmail.com", "gmx.com", "gmx.net", "zoho.com", "yandex.com",
]);
export const isPersonalDomain = (domain: string): boolean => PERSONAL_DOMAINS.has(domain.toLowerCase());

/** `key:"value"` for a value that came from mail, which anyone can write: double quotes are dropped so it cannot end the term. Mirrors quotedTerm in server/src/mail/query.ts. */
export const quotedTerm = (key: string, value: string): string => `${key}:"${value.replace(/"/g, "")}"`;

/**
 * The tabs the strip shows, in order: not hidden, and not "hide when empty" while empty. The tab being viewed always stays,
 * so it never disappears under someone who has just cleared it. Until counts arrive, nothing is hidden for being empty.
 */
export function visibleSplits(splits: Split[], counts: Counts | null, activeId?: string | null): Split[] {
  return splits.filter((s) => {
    if (s.id === activeId) return true;
    if (s.hidden) return false;
    return !(s.hideWhenEmpty && counts && counts.splits[s.id]?.total === 0);
  });
}

/** The tab the inbox opens on: the first one that isn't hidden. */
export const defaultSplit = (splits: Split[]): Split | undefined => splits.find((s) => !s.hidden);
