import { api, ApiError } from "../api.ts";
import type { CloudConnectInput, CloudRun, CloudStatus, EngineId, Routine, RoutineInput } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";
import { toast } from "./toasts.ts";

interface CloudState {
  status: CloudStatus | null;
  /** Why the status couldn't be read; older servers have no cloud agent. */
  error: string | null;
  /** The full history (up to 50 runs) has been fetched, not just the latest 20. */
  historyLoaded: boolean;
}

export const cloud = createStore<CloudState>({ status: null, error: null, historyLoaded: false });
export const useCloud = <S,>(selector: (s: CloudState) => S) => useStore(cloud, selector);
export const useConnected = () => useCloud((s) => s.status?.connected === true);

export const RUN_ACTIVE = new Set(["starting", "running"]);

let refreshing: Promise<void> | null = null;

export function refreshCloud(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = api
    .cloud()
    .then((status) => {
      const prev = cloud.get().status;
      // Keep older runs that a full history fetch brought in.
      const kept = (prev?.runs ?? []).filter((r) => !status.runs.some((x) => x.id === r.id) && r.createdAt < (status.runs.at(-1)?.createdAt ?? 0));
      cloud.set({ status: { ...status, runs: [...status.runs, ...kept] }, error: null });
    })
    .catch((err: Error) => {
      if (!cloud.get().status) cloud.set({ error: err.message });
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function loadHistory() {
  if (cloud.get().historyLoaded) return;
  try {
    const { runs } = await api.cloudRuns();
    for (const r of runs) upsertRun(r);
    cloud.set({ historyLoaded: true });
  } catch {
    /* the latest runs are already on screen */
  }
}

function patchStatus(fn: (s: CloudStatus) => Partial<CloudStatus>) {
  const s = cloud.get().status;
  if (s) cloud.set({ status: { ...s, ...fn(s) } });
}

export function upsertRun(run: CloudRun) {
  patchStatus((s) => {
    const rest = s.runs.filter((r) => r.id !== run.id);
    return { runs: [...rest, run].sort((a, b) => b.createdAt - a.createdAt) };
  });
}

export function runById(id: string | null): CloudRun | undefined {
  return id ? cloud.get().status?.runs.find((r) => r.id === id) : undefined;
}

// ---- Live updates -------------------------------------------------------------------------

const pendingRuns = new Map<string, ReturnType<typeof setTimeout>>();
let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** The server says a run changed: refetch it once for a burst of events, and refresh totals when it settles. */
export function cloudRunChanged(runId: string) {
  if (!cloud.get().status) return;
  if (pendingRuns.has(runId)) return;
  pendingRuns.set(
    runId,
    setTimeout(() => {
      pendingRuns.delete(runId);
      const before = runById(runId);
      api
        .cloudRun(runId)
        .then((run) => {
          upsertRun(run);
          if (!before || before.status !== run.status || before.costCents !== run.costCents) {
            clearTimeout(statusTimer);
            statusTimer = setTimeout(() => void refreshCloud(), 500);
          }
        })
        .catch(() => undefined);
    }, 120),
  );
}

// ---- Actions ------------------------------------------------------------------------------

export async function connectCloud(body: CloudConnectInput): Promise<void> {
  const status = await api.cloudConnect(body);
  cloud.set({ status, error: null, historyLoaded: false });
}

export async function disconnectCloud(): Promise<void> {
  const status = await api.cloudDisconnect();
  cloud.set({ status });
}

export async function startRun(instruction: string, context?: { threadIds: string[] }, engine?: EngineId | null): Promise<CloudRun> {
  const run = await api.startRun(instruction, context, engine);
  upsertRun(run);
  return run;
}

export async function replyToRun(id: string, text: string): Promise<CloudRun> {
  const run = await api.replyRun(id, text);
  upsertRun(run);
  return run;
}

export async function stopRun(id: string): Promise<void> {
  try {
    upsertRun(await api.stopRun(id));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't stop that run");
  }
}

export async function saveRoutine(input: RoutineInput, id?: string): Promise<Routine> {
  const r = await api.saveRoutine(input, id);
  patchStatus((s) => ({ routines: id ? s.routines.map((x) => (x.id === id ? r : x)) : [...s.routines, r] }));
  return r;
}

/** Flip a routine at once and put it back if the server says no. */
export async function setRoutineEnabled(r: Routine, enabled: boolean) {
  patchStatus((s) => ({ routines: s.routines.map((x) => (x.id === r.id ? { ...x, enabled } : x)) }));
  try {
    const saved = await api.saveRoutine({ name: r.name, instruction: r.instruction, trigger: r.trigger, enabled, engine: r.engine }, r.id);
    patchStatus((s) => ({ routines: s.routines.map((x) => (x.id === r.id ? saved : x)) }));
  } catch (err) {
    patchStatus((s) => ({ routines: s.routines.map((x) => (x.id === r.id ? r : x)) }));
    toast.error(err instanceof Error ? err.message : "Couldn't change that routine");
  }
}

export async function deleteRoutine(id: string) {
  await api.deleteRoutine(id);
  patchStatus((s) => ({ routines: s.routines.filter((x) => x.id !== id) }));
}

export async function runRoutineNow(id: string): Promise<CloudRun> {
  const run = await api.runRoutine(id);
  upsertRun(run);
  patchStatus((s) => ({ routines: s.routines.map((x) => (x.id === id ? { ...x, lastRunAt: run.createdAt } : x)) }));
  return run;
}

/** Palette and quick actions: start a run and say so if it can't start. */
export async function askAssistant(text: string, context?: { threadIds: string[] }): Promise<CloudRun | null> {
  try {
    return await startRun(text, context);
  } catch (err) {
    toast.error(runError(err));
    return null;
  }
}

/** Plain sentences for the refusals people actually hit. */
export function runError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 402) return "This month's budget is used up, so new runs are paused.";
    if (err.status === 429) return "Three runs are already going. Try again when one finishes.";
  }
  return err instanceof Error ? err.message : "Couldn't start that";
}

// ---- Formatting ---------------------------------------------------------------------------

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "claude-opus-5-5" -> "Claude Opus 5.5". */
export function modelName(id: string): string {
  const parts = id.split("-").filter(Boolean);
  if (parts[0] !== "claude" || parts.length < 3) return id;
  const words: string[] = [];
  const nums: string[] = [];
  for (const p of parts) (/^\d+$/.test(p) ? nums : words).push(p);
  if (words.length === 0 || nums.length === 0) return id;
  return `${words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ")} ${nums.join(".")}`;
}

export function statusLabel(s: CloudRun["status"]): string {
  return { starting: "Starting", running: "Running", done: "Done", failed: "Failed", budget: "Budget reached", stopped: "Stopped" }[s] ?? s;
}
