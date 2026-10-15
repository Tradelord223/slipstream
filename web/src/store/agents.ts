import { useEffect } from "react";
import { api, ApiError } from "../api.ts";
import type { Approval } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";
import { openThread } from "./nav.ts";
import { getRoute, navigate } from "./route.ts";
import { toast, toastStore } from "./toasts.ts";

export type ReviewTab = "waiting" | "decided";

interface ReviewState {
  /** Requests waiting for a person; null until the first answer. */
  pending: Approval[] | null;
  /** Past requests, loaded when the Decided tab opens. */
  decided: Approval[] | null;
  /** approval id -> the conversation it touched, known once the action ran. */
  threadByApproval: Record<string, string>;
  tab: ReviewTab;
  focusedId: string | null;
  /** A request arrived while the user was somewhere else. */
  unseen: boolean;
  error: string | null;
}

export const review = createStore<ReviewState>({
  pending: null,
  decided: null,
  threadByApproval: {},
  tab: "waiting",
  focusedId: null,
  unseen: false,
  error: null,
});

export const useReview = <S,>(selector: (s: ReviewState) => S) => useStore(review, selector);

/** Bumped whenever the server says something happened, so activity lists refetch. */
export const activityTick = createStore<{ n: number }>({ n: 0 });
export const bumpActivity = () => activityTick.set((s) => ({ n: s.n + 1 }));

/** Settings → Agents opens its "New agent" dialog when this is set (the palette's "Create agent token"). */
export const agentsUi = createStore<{ createOpen: boolean }>({ createOpen: false });
export function openCreateAgent() {
  agentsUi.set({ createOpen: true });
  navigate("/settings/agents");
}

/** Whether any agent exists, so an empty Review can point to setting one up. null = not known. */
const agentsExist = createStore<{ exists: boolean | null }>({ exists: null });
export function useAgentsExist(): boolean {
  const exists = useStore(agentsExist, (s) => s.exists);
  useEffect(() => {
    api
      .agents()
      .then((r) => agentsExist.set({ exists: r.agents.length > 0 }))
      .catch(() => undefined);
  }, []);
  return exists !== false;
}

let known: Set<string> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Coalesces a burst of events into one request. */
export function refreshApprovals(immediate = false) {
  clearTimeout(timer);
  timer = setTimeout(() => void loadPending(), immediate ? 0 : 250);
}

async function loadPending() {
  try {
    const { approvals } = await api.approvals("pending");
    announceNew(approvals);
    review.set({ pending: approvals, error: null });
    if (review.get().tab === "decided") void loadDecided();
  } catch (err) {
    // Older servers have no Review queue; keep the rail quiet rather than shouting.
    if (review.get().pending === null) review.set({ pending: [], error: err instanceof ApiError && err.status !== 404 ? err.message : null });
  }
}

function announceNew(next: Approval[]) {
  if (known === null) {
    known = new Set(next.map((a) => a.id));
    return;
  }
  const fresh = next.filter((a) => !known!.has(a.id));
  for (const a of fresh) known.add(a.id);
  if (fresh.length === 0 || getRoute().name === "review") return;
  review.set({ unseen: true });
  // A running send countdown owns the toast slot; the rail dot still shows the arrival.
  if (toastStore.get().current?.kind === "sending") return;
  const text = fresh.length === 1 ? `${fresh[0]!.agent.name} wants to ${fresh[0]!.title.toLowerCase()}` : `${fresh.length} requests are waiting for you`;
  toast.action(text, "Review", () => navigate("/review"), 7000);
}

export async function loadDecided() {
  try {
    const [{ approvals }, { activity }] = await Promise.all([api.approvals("decided"), api.activity({ limit: 200 })]);
    const threadByApproval: Record<string, string> = { ...review.get().threadByApproval };
    for (const a of activity) if (a.approvalId && a.threadIds?.[0]) threadByApproval[a.approvalId] = a.threadIds[0];
    review.set({ decided: approvals, threadByApproval, error: null });
  } catch (err) {
    review.set({ error: err instanceof Error ? err.message : "Couldn't load past requests" });
  }
}

export function markSeen() {
  if (review.get().unseen) review.set({ unseen: false });
}

export function setTab(tab: ReviewTab) {
  review.set({ tab, focusedId: null });
  if (tab === "decided") void loadDecided();
}

/** The cards on screen, in order. */
export function visibleApprovals(): Approval[] {
  const s = review.get();
  return (s.tab === "waiting" ? s.pending : s.decided) ?? [];
}

/** The focused card, falling back to the first. */
export function focusedApproval(): Approval | undefined {
  const items = visibleApprovals();
  const id = review.get().focusedId;
  return items.find((a) => a.id === id) ?? items[0];
}

export function moveReviewFocus(delta: number) {
  const items = visibleApprovals();
  if (items.length === 0) return;
  const cur = Math.max(0, items.findIndex((a) => a.id === focusedApproval()?.id));
  const next = items[Math.min(items.length - 1, Math.max(0, cur + delta))]!;
  review.set({ focusedId: next.id });
}

export function threadOf(a: Approval): string | undefined {
  return a.threadIds?.[0] ?? review.get().threadByApproval[a.id];
}

/** The draft behind a send request, when the agent named one. */
export function draftOf(a: Approval): string | undefined {
  const id = a.input?.draftId;
  return typeof id === "string" ? id : undefined;
}

export function openRelated(a: Approval | undefined = focusedApproval()) {
  if (!a) return;
  const id = threadOf(a);
  if (id) openThread(id);
}

export async function undoActivity(activityId: string, done = "Undone") {
  try {
    await api.undoActivity(activityId);
    toast.info(done);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't undo that");
  }
  bumpActivity();
}

/** Approve or reject a waiting request. The card leaves at once; the server has the last word. */
export async function decide(a: Approval, verb: "approve" | "reject") {
  const before = review.get().pending ?? [];
  const index = before.findIndex((x) => x.id === a.id);
  if (index < 0) return;
  const after = before.filter((x) => x.id !== a.id);
  const neighbour = after[Math.min(index, after.length - 1)];
  review.set({ pending: after, focusedId: neighbour?.id ?? null });
  try {
    if (verb === "reject") {
      await api.reject(a.id);
      toast.info("Rejected");
    } else {
      const res = await api.approve(a.id);
      const text = a.command === "drafts.send" ? "Approved · sending" : "Approved";
      const activityId = res.activityId;
      if (activityId) toast.undoable(text, () => void undoActivity(activityId, a.command === "drafts.send" ? "Send cancelled" : "Undone"), 10_000);
      else toast.info(text);
    }
  } catch (err) {
    const e = err instanceof ApiError ? err : null;
    if (e?.status === 409) toast.error("Already decided");
    else {
      toast.error(err instanceof Error ? err.message : "Couldn't reach Slipstream");
      // Nothing reached the server: put the card back instead of losing it.
      if (e?.status === 0) review.set({ pending: before });
    }
    refreshApprovals(true);
  }
  bumpActivity();
}
