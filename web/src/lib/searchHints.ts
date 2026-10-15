/** The operators the search language understands, with a few words on each. */
export const SEARCH_HINTS: { token: string; note: string }[] = [
  { token: "from:", note: "sender" },
  { token: "to:", note: "recipient" },
  { token: "has:attachment", note: "with files" },
  { token: "is:unread", note: "unread" },
  { token: "is:starred", note: "starred" },
  { token: "label:", note: "a label" },
  { token: "before:", note: "2026-10-01" },
  { token: "after:", note: "2026-09-01" },
  { token: "newer:7d", note: "last week" },
  { token: "in:sent", note: "sent mail" },
  { token: "in:all", note: "everywhere" },
];
