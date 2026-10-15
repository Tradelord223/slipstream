import { createStore, useStore } from "./createStore.ts";

export interface Toast {
  id: number;
  kind: "info" | "error" | "sending";
  text: string;
  /** Label for the undo affordance, e.g. "Undo". */
  undoLabel?: string;
  /** Shown as a keycap next to the undo label. */
  undoKey?: string;
  /** Countdown target for a pending send. */
  until?: number;
  actionLabel?: string;
}

interface ToastState {
  current: Toast | null;
}

export const toastStore = createStore<ToastState>({ current: null });
export const useToast = () => useStore(toastStore, (s) => s.current);

let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let undoFn: (() => void) | null = null;
let undoToastId = 0;
const undoStack: { fn: () => void; label: string }[] = [];
let actionFn: (() => void) | null = null;

function show(t: Omit<Toast, "id">, ms: number | null) {
  clearTimeout(timer);
  const id = nextId++;
  toastStore.set({ current: { ...t, id } });
  if (ms !== null) timer = setTimeout(() => dismiss(id), ms);
  return id;
}

export function dismiss(id?: number) {
  const cur = toastStore.get().current;
  if (!cur || (id !== undefined && cur.id !== id)) return;
  clearTimeout(timer);
  toastStore.set({ current: null });
  if (cur.id === undoToastId) undoFn = null;
}

export const toast = {
  info(text: string, ms = 3500) {
    return show({ kind: "info", text }, ms);
  },
  error(text: string, ms = 6000) {
    return show({ kind: "error", text }, ms);
  },
  /** An undoable action: pressing Z (or the button) runs `undo`. */
  undoable(text: string, undo: () => void, ms = 8000) {
    undoStack.push({ fn: undo, label: text });
    if (undoStack.length > 20) undoStack.shift();
    undoFn = undo;
    const id = show({ kind: "info", text, undoLabel: "Undo", undoKey: "Z" }, ms);
    undoToastId = id;
    return id;
  },
  /** A message with its own action button and no undo, e.g. "Open". */
  action(text: string, label: string, run: () => void, ms = 6000) {
    actionFn = run;
    return show({ kind: "info", text, actionLabel: label }, ms);
  },
  sending(text: string, until: number, undo: () => void) {
    undoFn = undo;
    const id = show({ kind: "sending", text, undoLabel: "Undo", undoKey: "Z", until }, null);
    undoToastId = id;
    return id;
  },
};

/** Z: undo the most recent undoable action. Returns whether anything was undone. */
export function undoLast(): boolean {
  const cur = toastStore.get().current;
  if (cur && cur.id === undoToastId && undoFn) {
    const fn = undoFn;
    undoFn = null;
    removeFromStack(fn);
    dismiss(cur.id);
    fn();
    return true;
  }
  const last = undoStack.pop();
  if (!last) return false;
  last.fn();
  return true;
}

function removeFromStack(fn: () => void) {
  const i = undoStack.findIndex((u) => u.fn === fn);
  if (i >= 0) undoStack.splice(i, 1);
}

export function runToastAction() {
  const fn = actionFn;
  actionFn = null;
  dismiss();
  fn?.();
}

/** Called when a sending toast resolves. */
export function settleSending(text: string, kind: "info" | "error" = "info") {
  const cur = toastStore.get().current;
  if (cur && (cur.kind === "sending" || cur.text.startsWith("Sending"))) {
    undoFn = null;
    show({ kind, text }, kind === "error" ? 6000 : 3000);
  }
}
