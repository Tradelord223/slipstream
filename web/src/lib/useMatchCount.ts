import { useEffect, useState } from "react";
import { api } from "../api.ts";

const LIMIT = 100;
/** Inbox counts read further, so a split's number is rarely "100+". */
const INBOX_LIMIT = 500;

export type MatchState = { state: "idle" } | { state: "loading" } | { state: "ready"; count: number; more: boolean } | { state: "error"; message: string };

/**
 * How many conversations a search matches right now: debounced, and a stale request is dropped.
 * `inbox` counts only what is in the inbox, the way a split holds mail; without it the search runs over all mail, as a label rule does.
 */
export function useMatchCount(query: string, opts: { inbox?: boolean; delay?: number } = {}): MatchState {
  const { inbox = false, delay = 350 } = opts;
  const [result, setResult] = useState<MatchState>({ state: "idle" });
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult({ state: "idle" });
      return;
    }
    setResult({ state: "loading" });
    const ctl = new AbortController();
    const limit = inbox ? INBOX_LIMIT : LIMIT;
    const timer = setTimeout(() => {
      api
        .threads({ view: "search", q: inbox && !/\bin:/.test(q) ? `in:inbox ${q}` : q, limit }, ctl.signal)
        .then((page) => setResult({ state: "ready", count: page.threads.length, more: page.threads.length >= limit || Boolean(page.next) }))
        .catch((err: Error) => {
          if (err.name !== "AbortError") setResult({ state: "error", message: err.message });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query, inbox, delay]);
  return result;
}

export function matchText(m: MatchState): string {
  switch (m.state) {
    case "idle":
      return "";
    case "loading":
      return "Checking…";
    case "error":
      return "Couldn't run that search.";
    case "ready":
      if (m.count === 0) return "Nothing matches right now.";
      return `${m.count.toLocaleString("en-US")}${m.more ? "+" : ""} ${m.count === 1 && !m.more ? "conversation matches" : "conversations match"} right now.`;
  }
}

/** "23 conversations", "500+ conversations", or nothing while it is still counting. */
export function countText(m: MatchState): string {
  switch (m.state) {
    case "ready":
      return `${m.count.toLocaleString("en-US")}${m.more ? "+" : ""} ${m.count === 1 && !m.more ? "conversation" : "conversations"}`;
    case "loading":
      return "Counting…";
    case "error":
      return "Couldn't count";
    default:
      return "";
  }
}
