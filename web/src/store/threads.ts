import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api.ts";
import type { Thread, ThreadDetail } from "../types.ts";

interface Entry {
  detail: ThreadDetail | null;
  error: string | null;
  stale: boolean;
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const MAX_ENTRIES = 120;

const notify = () => listeners.forEach((l) => l());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

function put(id: string, entry: Entry) {
  cache.delete(id);
  cache.set(id, entry);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  notify();
}

export function loadThread(id: string): Promise<void> {
  const running = inflight.get(id);
  if (running) return running;
  const p = api
    .thread(id)
    .then((detail) => put(id, { detail, error: null, stale: false, at: Date.now() }))
    .catch((err: Error) => {
      const prev = cache.get(id);
      put(id, { detail: prev?.detail ?? null, error: err.message, stale: false, at: Date.now() });
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Warm the cache for rows the user is likely to open next. */
export function prefetch(ids: (string | undefined)[]) {
  for (const id of ids) {
    if (!id || cache.has(id) || inflight.has(id)) continue;
    void loadThread(id);
  }
}

/** Mark cached conversations out of date (they refetch when next shown). */
export function invalidate(ids: string[]) {
  let changed = false;
  for (const id of ids) {
    const e = cache.get(id);
    if (!e) continue;
    cache.set(id, { ...e, stale: true });
    changed = true;
  }
  if (changed) notify();
}

/** Optimistically change the summary fields of a cached conversation. */
export function patchCachedThread(ids: string[], change: Partial<Thread>) {
  let changed = false;
  for (const id of ids) {
    const e = cache.get(id);
    if (!e?.detail) continue;
    cache.set(id, { ...e, detail: { ...e.detail, thread: { ...e.detail.thread, ...change } } });
    changed = true;
  }
  if (changed) notify();
}

export function cachedThread(id: string): ThreadDetail | null {
  return cache.get(id)?.detail ?? null;
}

export function useThread(id: string | null): { detail: ThreadDetail | null; error: string | null; loading: boolean; retry: () => void } {
  const entry = useSyncExternalStore(subscribe, () => (id ? cache.get(id) : undefined));
  useEffect(() => {
    if (!id) return;
    if (!entry || entry.stale) void loadThread(id);
  }, [id, entry]);
  return {
    detail: entry?.detail ?? null,
    error: entry?.error && !entry.detail ? entry.error : null,
    loading: !entry || (entry.stale && !entry.detail),
    retry: () => {
      if (id) {
        cache.delete(id);
        void loadThread(id);
        notify();
      }
    },
  };
}
