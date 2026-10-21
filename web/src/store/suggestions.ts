import { api } from "../api.ts";
import type { SplitSuggestion } from "../types.ts";
import { refreshCounts } from "./counts.ts";
import { createStore, useStore } from "./createStore.ts";
import { refreshSession } from "./session.ts";
import { toast } from "./toasts.ts";

/** Tabs worth making, from `splits.suggest`. `current` is the one quiet line at the end of the tab strip. */
interface State {
  status: "idle" | "loading" | "ready" | "error";
  items: SplitSuggestion[];
  current: SplitSuggestion | null;
  error: string | null;
}

export const suggestions = createStore<State>({ status: "idle", items: [], current: null, error: null });
export const useSuggestions = <S,>(selector: (s: State) => S) => useStore(suggestions, selector);

const SHOWN_KEY = "ss-split-suggestion";
const DAY = 86_400_000;
const STALE = 60_000;

let fetchedAt = 0;
let inflight: Promise<void> | null = null;

function readShown(): { key: string; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "null") as { key?: unknown; at?: unknown } | null;
    return v && typeof v.key === "string" && typeof v.at === "number" ? { key: v.key, at: v.at } : null;
  } catch {
    return null;
  }
}

/**
 * One suggestion at a time, and a new one at most once a day: the one already shown stays until it is added or dismissed,
 * then the next waits until a day has passed since the last was first shown.
 */
function pick(items: SplitSuggestion[], now = Date.now()): SplitSuggestion | null {
  const shown = readShown();
  const same = shown && items.find((i) => i.key === shown.key);
  if (same) return same;
  if (shown && now - shown.at < DAY) return null;
  const next = items[0] ?? null;
  if (next) {
    try {
      localStorage.setItem(SHOWN_KEY, JSON.stringify({ key: next.key, at: now }));
    } catch {
      /* the line is still shown this session */
    }
  }
  return next;
}

export function refreshSuggestions(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && suggestions.get().status === "ready" && Date.now() - fetchedAt < STALE) return Promise.resolve();
  if (suggestions.get().status !== "ready") suggestions.set({ status: "loading", error: null });
  inflight = api
    .suggestSplits()
    .then((items) => {
      fetchedAt = Date.now();
      suggestions.set({ status: "ready", items, current: pick(items), error: null });
    })
    .catch((err: Error) => {
      suggestions.set({ status: "error", error: err.message || "Couldn't look for splits" });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function drop(key: string) {
  const items = suggestions.get().items.filter((i) => i.key !== key);
  const cur = suggestions.get().current;
  suggestions.set({ items, current: cur?.key === key ? null : cur });
}

/** Not suggesting this one again. It leaves at once; if the server can't save that, it says so and comes back. */
export async function dismissSuggestion(s: SplitSuggestion): Promise<void> {
  const before = suggestions.get();
  drop(s.key);
  try {
    await api.dismissSplitSuggestion(s.key);
  } catch (err) {
    suggestions.set({ items: before.items, current: before.current });
    toast.error(err instanceof Error ? err.message : "Couldn't dismiss that");
  }
}

export async function acceptSuggestion(s: SplitSuggestion): Promise<boolean> {
  try {
    await api.createSplit(s.name, s.query);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't add that split");
    return false;
  }
  drop(s.key);
  await refreshSession();
  refreshCounts(true);
  toast.info(`Added ${s.name}`);
  return true;
}
