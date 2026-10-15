import { api } from "../api.ts";
import type { Counts } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";

export const counts = createStore<{ data: Counts | null }>({ data: null });
export const useCounts = () => useStore(counts, (s) => s.data);

let timer: ReturnType<typeof setTimeout> | undefined;
let last = 0;

/** Throttled: a burst of events asks the server once. */
export function refreshCounts(immediate = false) {
  clearTimeout(timer);
  const wait = immediate ? 0 : Math.max(0, 1000 - (Date.now() - last));
  timer = setTimeout(async () => {
    last = Date.now();
    try {
      counts.set({ data: await api.counts() });
    } catch {
      /* counts are decoration; the next event retries */
    }
  }, wait);
}

/** Optimistic nudge so badges move with the row, before the server answers. */
export function bumpCounts(delta: { unread?: number; total?: number; splitId?: string | null }) {
  const c = counts.get().data;
  if (!c) return;
  const next: Counts = { ...c, inbox: { total: c.inbox.total + (delta.total ?? 0), unread: c.inbox.unread + (delta.unread ?? 0) } };
  if (delta.splitId && c.splits[delta.splitId]) {
    const s = c.splits[delta.splitId]!;
    next.splits = { ...c.splits, [delta.splitId]: { total: s.total + (delta.total ?? 0), unread: s.unread + (delta.unread ?? 0) } };
  }
  counts.set({ data: next });
}
