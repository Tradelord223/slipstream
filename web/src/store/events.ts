import type { ServerEvent, SyncProgress } from "../types.ts";
import { bumpActivity, refreshApprovals } from "./agents.ts";
import { refreshAutopilot } from "./autopilot.ts";
import { cloudRunChanged, refreshCloud } from "./cloud.ts";
import { onDraftEvent } from "./compose.ts";
import { refreshEngines } from "./engines.ts";
import { refreshLabels } from "./labels.ts";
import { createStore, useStore } from "./createStore.ts";
import { refreshCounts } from "./counts.ts";
import { reload } from "./list.ts";
import { refreshSession, session } from "./session.ts";
import { invalidate } from "./threads.ts";
import { toast } from "./toasts.ts";

export interface ImportJob {
  jobId: string;
  accountId: string;
  status: "running" | "done" | "failed";
  imported: number;
  error?: string;
}

export const importState = createStore<{ job: ImportJob | null }>({ job: null });
export const useImportJob = () => useStore(importState, (s) => s.job);

/** Messages stored so far by each account's first sync, by account id. */
export const syncProgress = createStore<Record<string, number>>({});
export const useSyncFetched = (accountId: string | null) => useStore(syncProgress, (s) => (accountId ? (s[accountId] ?? 0) : 0));

/** Bumped when teammates change something, so shared views refetch. */
export const teamTick = createStore<{ n: number }>({ n: 0 });

let source: EventSource | null = null;
let hadError = false;

export function connectEvents() {
  if (source) return;
  const es = new EventSource("/api/events");
  source = es;
  es.addEventListener("hello", () => {
    if (hadError) {
      hadError = false;
      reload(true);
      refreshCounts(true);
      refreshApprovals(true);
      bumpActivity();
      void refreshCloud();
      void refreshEngines();
      refreshAutopilot(true);
      refreshLabels(true);
      void refreshSession();
    }
  });
  es.onerror = () => {
    hadError = true;
  };
  for (const type of ["threads", "sync", "drafts", "team", "import", "activity", "approval", "cloud", "autopilot"] as const) {
    es.addEventListener(type, (ev) => {
      try {
        handle(JSON.parse((ev as MessageEvent<string>).data) as ServerEvent);
      } catch {
        /* ignore malformed event */
      }
    });
  }
}

export function disconnectEvents() {
  source?.close();
  source = null;
}

// The stream is bound to the person who opened it. It closes when the screen that opened it goes: Shell and
// OnboardingView both close it as they unmount, and signing out or an expired cookie replaces them with the sign-in.

function handle(e: ServerEvent) {
  switch (e.type) {
    case "threads":
      invalidate(e.threadIds);
      reload();
      refreshCounts();
      refreshLabels();
      break;
    case "sync": {
      if (typeof e.fetched === "number") {
        const fetched = e.fetched;
        syncProgress.set((s) => ({ ...s, [e.accountId]: fetched }));
      }
      // The web event type doesn't list `progress` yet; the server sends it with each sync event.
      const { progress } = e as { progress?: SyncProgress };
      const accounts = session.get().accounts.map((a) =>
        a.id === e.accountId
          ? {
              ...a,
              syncStatus: e.status,
              syncError: e.error ?? null,
              lastSyncedAt: e.status === "idle" ? Date.now() : a.lastSyncedAt,
              // The server's count for the stage a sync is in, when it sends one (see Arriving).
              ...(progress ? { progress } : {}),
            }
          : a,
      );
      session.set({ accounts });
      // An idle event doesn't mean the first sync is complete (a run can end early), so first-run setup waits for the
      // server's own firstSyncedAt, picked up here once a run settles.
      if (session.get().status === "onboarding" && e.status !== "syncing") void refreshSession();
      break;
    }
    case "drafts":
      onDraftEvent(e);
      break;
    case "approval":
      refreshApprovals();
      bumpActivity();
      break;
    case "activity":
      bumpActivity();
      break;
    case "cloud":
      cloudRunChanged(e.runId);
      break;
    case "autopilot":
      refreshAutopilot();
      break;
    case "team":
      teamTick.set((s) => ({ n: s.n + 1 }));
      break;
    case "import": {
      importState.set({ job: { jobId: e.jobId, accountId: e.accountId, status: e.status, imported: e.imported, error: e.error } });
      if (e.status === "done") {
        toast.info(`Imported ${e.imported.toLocaleString("en-US")} messages`);
        void refreshSession();
        reload(true);
        refreshCounts(true);
      } else if (e.status === "failed") toast.error(e.error ? `Import stopped: ${e.error}` : "The import stopped early");
      break;
    }
  }
}
