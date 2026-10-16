import { createStore, useStore } from "./createStore.ts";
import { assistantOn } from "./session.ts";

export const ASSISTANT_MIN = 320;
export const ASSISTANT_MAX = 640;
export const ASSISTANT_DEFAULT = 380;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

const clampWidth = (w: number) => Math.min(ASSISTANT_MAX, Math.max(ASSISTANT_MIN, Math.round(w)));

interface AssistantState {
  open: boolean;
  width: number;
  /** The conversation on screen; null is a fresh chat. */
  runId: string | null;
  view: "chat" | "history";
  /** The access and budget dialog, reachable from the panel, the page and Settings. */
  accessOpen: boolean;
  /** What's typed in a fresh chat survives closing the panel. */
  draft: string;
}

export const assistant = createStore<AssistantState>({
  open: read("ss-assistant") === "1",
  width: clampWidth(Number(read("ss-assistant-w")) || ASSISTANT_DEFAULT),
  runId: read("ss-assistant-run"),
  view: "chat",
  accessOpen: false,
  draft: "",
});

export const useAssistant = <S,>(selector: (s: AssistantState) => S) => useStore(assistant, selector);

export function toggleAssistant() {
  setOpen(!assistant.get().open);
}

/** With the assistant switched off nothing opens, and nothing is remembered as open for when it comes back on. */
export function setOpen(open: boolean) {
  if (open && !assistantOn()) return;
  assistant.set({ open, view: "chat" });
  write("ss-assistant", open ? "1" : "0");
}

export function openAssistant(opts: { runId?: string | null; draft?: string } = {}) {
  if (!assistantOn()) return;
  const patch: Partial<AssistantState> = { open: true, view: "chat" };
  if (opts.runId !== undefined) patch.runId = opts.runId;
  if (opts.draft !== undefined) patch.draft = opts.draft;
  assistant.set(patch);
  write("ss-assistant", "1");
  if (opts.runId !== undefined) write("ss-assistant-run", opts.runId);
}

export function showRun(id: string | null) {
  assistant.set({ runId: id, view: "chat" });
  write("ss-assistant-run", id);
}

export function newChat() {
  showRun(null);
}

export function setWidth(w: number, persist = false) {
  const width = clampWidth(w);
  assistant.set({ width });
  if (persist) write("ss-assistant-w", String(width));
}

export function setDraft(draft: string) {
  assistant.set({ draft });
}

/** Below this the sidebar would squeeze the page, so it opens as a sheet instead. */
export const ASSISTANT_INLINE_MIN = 1200;
/** The page keeps at least this much room beside the sidebar. */
const MAIN_MIN = 600;

/** The width actually used: what the person chose, unless the window can't spare it. */
export function effectiveWidth(chosen: number, railShown: boolean, windowWidth: number): number {
  const room = windowWidth - (railShown ? 232 : 0) - MAIN_MIN;
  return Math.max(ASSISTANT_MIN, Math.min(chosen, room));
}
