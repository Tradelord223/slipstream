import { api } from "../api.ts";
import { createStore, useStore } from "./createStore.ts";
import { cachedThread, patchCachedBodies } from "./threads.ts";

/** Messages whose full text is on its way, or couldn't be fetched. A message in neither state is complete or not asked for. */
const status = createStore<{ byId: Record<string, "loading" | "failed"> }>({ byId: {} });
export const useBodyStatus = (messageId: string) => useStore(status, (s) => s.byId[messageId]);

const inflight = new Map<string, Promise<void>>();

function mark(ids: string[], value: "loading" | "failed" | undefined) {
  const byId = { ...status.get().byId };
  for (const id of ids) {
    if (value) byId[id] = value;
    else delete byId[id];
  }
  status.set({ byId });
}

/**
 * Brings the full text of messages that only have a preview and puts it in the cached conversation. Resolves once every
 * one of them has been tried (also when another call was already fetching it); the ones that failed come back in `failed`.
 */
export async function ensureBodies(threadId: string, ids: string[]): Promise<{ failed: string[] }> {
  const detail = cachedThread(threadId);
  const wanted = ids.filter((id) => detail?.messages.find((m) => m.id === id)?.bodyState === "none");
  const fresh = wanted.filter((id) => !inflight.has(id));
  if (fresh.length > 0) {
    mark(fresh, "loading");
    const run = api
      .threadBodies(threadId, fresh)
      .then((res) => {
        patchCachedBodies(threadId, res.messages);
        mark(res.messages.map((m) => m.id), undefined);
        mark(res.failed.map((f) => f.id), "failed");
      })
      .catch(() => mark(fresh, "failed"))
      .finally(() => {
        for (const id of fresh) inflight.delete(id);
      });
    for (const id of fresh) inflight.set(id, run);
  }
  await Promise.all(wanted.map((id) => inflight.get(id)));
  return { failed: wanted.filter((id) => status.get().byId[id] === "failed") };
}
