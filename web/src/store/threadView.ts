import { createStore, useStore } from "./createStore.ts";

interface ThreadViewState {
  threadId: string | null;
  messageIds: string[];
  /** Index of the message that n/p and o act on. */
  focus: number;
  expanded: ReadonlySet<string>;
  /** Bumped to ask the view to scroll the focused message into view. */
  scrollTick: number;
}

export const threadView = createStore<ThreadViewState>({ threadId: null, messageIds: [], focus: 0, expanded: new Set(), scrollTick: 0 });
export const useThreadView = <S,>(selector: (s: ThreadViewState) => S) => useStore(threadView, selector);

/** Called when a conversation's messages are known. The latest message starts expanded. */
export function enterThread(threadId: string, messageIds: string[]) {
  const s = threadView.get();
  if (s.threadId === threadId && s.messageIds.join() === messageIds.join()) return;
  const same = s.threadId === threadId;
  const last = messageIds[messageIds.length - 1];
  threadView.set({
    threadId,
    messageIds,
    focus: same ? Math.min(s.focus, Math.max(messageIds.length - 1, 0)) : Math.max(messageIds.length - 1, 0),
    expanded: same ? s.expanded : new Set(last ? [last] : []),
  });
}

export function toggleMessage(id: string) {
  const next = new Set(threadView.get().expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  threadView.set({ expanded: next });
}

export function expandMessage(id: string) {
  const s = threadView.get();
  if (s.expanded.has(id)) return;
  threadView.set({ expanded: new Set([...s.expanded, id]) });
}

export function toggleExpandAll() {
  const s = threadView.get();
  const all = s.messageIds.every((id) => s.expanded.has(id));
  threadView.set({ expanded: all ? new Set(s.messageIds.slice(-1)) : new Set(s.messageIds) });
}

export function moveMessage(delta: number) {
  const s = threadView.get();
  const focus = Math.min(Math.max(s.focus + delta, 0), s.messageIds.length - 1);
  const id = s.messageIds[focus];
  const expanded = id && !s.expanded.has(id) ? new Set([...s.expanded, id]) : s.expanded;
  threadView.set({ focus, expanded, scrollTick: s.scrollTick + 1 });
}

export function toggleFocusedMessage() {
  const s = threadView.get();
  const id = s.messageIds[s.focus];
  if (id) toggleMessage(id);
}
