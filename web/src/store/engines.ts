import { api } from "../api.ts";
import type { EngineId, EnginesOverview, EngineStatus } from "../types.ts";
import { cloud, refreshCloud } from "./cloud.ts";
import { assistantName } from "../lib/engines.ts";
import { createStore, useStore } from "./createStore.ts";

interface EnginesState {
  overview: EnginesOverview | null;
  /** Why the list couldn't be read. */
  error: string | null;
}

export const engines = createStore<EnginesState>({ overview: null, error: null });
export const useEngines = <S,>(selector: (s: EnginesState) => S) => useStore(engines, selector);

let loading: Promise<void> | null = null;

export function refreshEngines(): Promise<void> {
  if (loading) return loading;
  loading = api
    .engines()
    .then((overview) => engines.set({ overview, error: null }))
    .catch((err: Error) => {
      if (!engines.get().overview) engines.set({ error: err.message });
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Every write answers with the fresh overview. */
export function setOverview(overview: EnginesOverview) {
  engines.set({ overview, error: null });
}

export async function chooseEngine(id: EngineId) {
  setOverview(await api.setDefaultEngine(id));
}

export async function chooseModel(id: EngineId, model: string | null) {
  setOverview(await api.setEngineModel(id, model));
}

/** The server keeps one set of budgets; the managed agent's status carries them too. */
export async function saveBudgets(b: { runBudgetCents?: number; monthlyBudgetCents?: number }) {
  setOverview(await api.saveBudgets(b));
  void refreshCloud();
}

/** The engine a new run would use right now, as the server resolves it. */
export function effectiveEngine(o: EnginesOverview | null): EngineStatus | null {
  return o?.resolvedEngine ? (o.engines.find((e) => e.id === o.resolvedEngine) ?? null) : null;
}

export const useEffectiveEngine = () => useEngines((s) => effectiveEngine(s.overview));

/** What the assistant is called right now: the engine it would run on, or just "Assistant". */
export const useAssistantName = () => useEngines((s) => assistantName(effectiveEngine(s.overview)?.id));

/** Something can run an agent: the managed cloud agent, or any ready engine. */
export function useCanRun(): boolean {
  const overview = useEngines((s) => s.overview);
  const connected = useStore(cloud, (s) => s.status?.connected === true);
  return connected || Boolean(overview?.engines.some((e) => e.ready));
}

/** Engines that can sit behind Autopilot: everything but the managed agent, whose tools are fixed. */
export const autopilotEngines = (o: EnginesOverview | null) => o?.engines.filter((e) => e.id !== "managed:anthropic") ?? [];
