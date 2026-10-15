import { useEffect, useState } from "react";
import { api } from "../api.ts";

const LIMIT = 100;

export type MatchState = { state: "idle" } | { state: "loading" } | { state: "ready"; count: number; more: boolean } | { state: "error"; message: string };

/** How many conversations a search matches right now: debounced, and a stale request is dropped. */
export function useMatchCount(query: string): MatchState {
  const [result, setResult] = useState<MatchState>({ state: "idle" });
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult({ state: "idle" });
      return;
    }
    setResult({ state: "loading" });
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api
        .threads({ view: "search", q, limit: LIMIT }, ctl.signal)
        .then((page) => setResult({ state: "ready", count: page.threads.length, more: page.threads.length >= LIMIT || Boolean(page.next) }))
        .catch((err: Error) => {
          if (err.name !== "AbortError") setResult({ state: "error", message: err.message });
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query]);
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
