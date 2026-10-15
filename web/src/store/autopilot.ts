import { api } from "../api.ts";
import type { AutopilotItem, AutopilotOverview, AutopilotPatch, CloudRun, SenderRuleAction } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";
import { openThread } from "./nav.ts";
import { toast } from "./toasts.ts";

interface AutopilotState {
  /** null until the first answer. */
  overview: AutopilotOverview | null;
  /** Why it couldn't be read. */
  error: string | null;
  /** The row the keyboard is on. */
  focusedId: string | null;
}

export const autopilot = createStore<AutopilotState>({ overview: null, error: null, focusedId: null });
export const useAutopilot = <S,>(selector: (s: AutopilotState) => S) => useStore(autopilot, selector);

let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: AbortController | null = null;

/** Coalesces a burst of events into one request. */
export function refreshAutopilot(immediate = false) {
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      inflight?.abort();
      const ctl = (inflight = new AbortController());
      api
        .autopilot(ctl.signal)
        .then((overview) => autopilot.set({ overview, error: null }))
        .catch((err: Error) => {
          if (err.name === "AbortError") return;
          if (!autopilot.get().overview) autopilot.set({ error: err.message });
        });
    },
    immediate ? 0 : 200,
  );
}

function take(overview: AutopilotOverview) {
  autopilot.set({ overview, error: null });
}

async function write<T extends AutopilotOverview>(call: () => Promise<T>, failure: string): Promise<T | null> {
  try {
    const res = await call();
    take(res);
    return res;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : failure);
    return null;
  }
}

export const patchAutopilot = (patch: AutopilotPatch) => write(() => api.updateAutopilot(patch), "Couldn't change Autopilot");
export const backfillAutopilot = (days: number) => write(() => api.autopilotBackfill(days), "Couldn't start sorting");
export const runAutopilot = () => write(() => api.autopilotRun(), "Couldn't check for new mail");
export const acceptItem = (id: string) => write(() => api.autopilotAccept(id), "Couldn't accept that");
export const dismissItem = (id: string) => write(() => api.autopilotDismiss(id), "Couldn't dismiss that");
export const undoItem = (id: string) => write(() => api.autopilotUndo(id), "Couldn't undo that");
export const addSenderRule = (pattern: string, action: SenderRuleAction) => write(() => api.saveSenderRule(pattern, action), "Couldn't save that rule");
export const removeSenderRule = (id: string) => write(() => api.deleteSenderRule(id), "Couldn't remove that rule");

/** Start Autopilot, and sort the last few days too when asked. The first call's engine problem shows in the header. */
export async function turnOn(backfillDays?: number) {
  const on = await patchAutopilot({ enabled: true });
  if (on && backfillDays) await backfillAutopilot(backfillDays);
}

export async function acceptAll() {
  const res = await write(() => api.autopilotAcceptAll(), "Couldn't accept them");
  if (res) toast.info(res.accepted === 1 ? "Accepted 1 suggestion" : `Accepted ${res.accepted} suggestions`);
}

/** Settings fields (the playbook, how you write) don't flash an error toast; the caller shows it inline. */
export async function saveSettings(patch: AutopilotPatch): Promise<void> {
  take(await api.updateAutopilot(patch));
}

/** For the add-a-rule form, which shows the server's message beside the field. */
export async function createSenderRule(pattern: string, action: SenderRuleAction): Promise<void> {
  take(await api.saveSenderRule(pattern, action));
}

export async function learnVoice(): Promise<CloudRun> {
  return api.autopilotLearnVoice();
}

// ---- What the page shows ------------------------------------------------------------------------

export const isProposal = (i: AutopilotItem) => i.stage === "decided" && !i.applied && i.status === "open";

/** Kept for you: it needs an answer or is urgent, it's still in the inbox, and you haven't said otherwise. */
export const needsYou = (i: AutopilotItem) =>
  i.stage === "decided" &&
  i.decision?.action === "keep" &&
  (i.decision.needsReply || i.decision.priority === "urgent") &&
  i.inInbox &&
  (i.status === "open" || i.status === "accepted");

/** The rows in the order the page draws them, for the keyboard. */
export function orderedItems(items: AutopilotItem[]): AutopilotItem[] {
  return [...items.filter(needsYou), ...items.filter((i) => !needsYou(i))];
}

export function moveFocus(delta: number) {
  const o = autopilot.get().overview;
  if (!o) return;
  const rows = orderedItems(o.items);
  if (rows.length === 0) return;
  const cur = Math.max(0, rows.findIndex((r) => r.id === autopilot.get().focusedId));
  autopilot.set({ focusedId: rows[Math.min(rows.length - 1, Math.max(0, cur + delta))]!.id });
}

export function focusedItem(): AutopilotItem | undefined {
  const o = autopilot.get().overview;
  if (!o) return undefined;
  const rows = orderedItems(o.items);
  return rows.find((r) => r.id === autopilot.get().focusedId) ?? rows[0];
}

export function openItem(i: AutopilotItem | undefined = focusedItem()) {
  if (i) openThread(i.threadId);
}

export function proposalCount(o: AutopilotOverview | null): number {
  return o ? o.items.filter(isProposal).length : 0;
}
