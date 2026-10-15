import { createStore, useStore } from "./createStore.ts";

export type PaletteMode = "root" | "label" | "move" | "removeLabel" | "goLabel" | "account";

export interface RemindRequest {
  title: string;
  onPick: (at: Date) => void;
}

export interface Tip {
  id: string;
  text: string;
  key: string;
}

interface UiState {
  railOpen: boolean;
  sheetOpen: boolean;
  contextOpen: boolean;
  palette: { mode: PaletteMode; ids: string[] } | null;
  remind: RemindRequest | null;
  shortcuts: boolean;
  searchOpen: boolean;
  tip: Tip | null;
  chord: string | null;
  /** Set while a keymap row waits for a keypress, so global shortcuts stay quiet. */
  capturing: boolean;
}

const read = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
};

export const ui = createStore<UiState>({
  railOpen: read("ss-rail", true),
  sheetOpen: false,
  contextOpen: read("ss-context", true),
  palette: null,
  remind: null,
  shortcuts: false,
  searchOpen: false,
  tip: null,
  chord: null,
  capturing: false,
});

export const useUi = <S,>(selector: (s: UiState) => S) => useStore(ui, selector);

const persist = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
};

export function toggleRail() {
  const next = !ui.get().railOpen;
  ui.set({ railOpen: next });
  persist("ss-rail", next);
}

export function toggleContext() {
  const next = !ui.get().contextOpen;
  ui.set({ contextOpen: next });
  persist("ss-context", next);
}

export const openPalette = (mode: PaletteMode = "root", ids: string[] = []) => ui.set({ palette: { mode, ids }, sheetOpen: false });
export const closePalette = () => ui.set({ palette: null });
export const openRemind = (r: RemindRequest) => ui.set({ remind: r });
export const closeRemind = () => ui.set({ remind: null });

const dismissedTips = new Set<string>();
export function showTip(tip: Tip) {
  if (dismissedTips.has(tip.id)) return;
  ui.set({ tip });
}
export function dismissTip() {
  const t = ui.get().tip;
  if (t) dismissedTips.add(t.id);
  ui.set({ tip: null });
}
