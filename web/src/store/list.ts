import { api, type ListParams } from "../api.ts";
import type { Thread } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";
import type { MailView } from "./route.ts";

export type ListFilter = "all" | "unread" | "starred";

export interface ListState {
  key: string;
  view: MailView | null;
  params: ListParams | null;
  rows: Thread[];
  visible: Thread[];
  next: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  focusedId: string | null;
  selected: ReadonlySet<string>;
  filter: ListFilter;
  /** Bumped when the list needs its scroll position reset. */
  resetToken: number;
}

export const list = createStore<ListState>({
  key: "",
  view: null,
  params: null,
  rows: [],
  visible: [],
  next: null,
  status: "idle",
  loadingMore: false,
  error: null,
  focusedId: null,
  selected: new Set(),
  filter: "all",
  resetToken: 0,
});

export const useList = <S,>(selector: (s: ListState) => S) => useStore(list, selector);

type Patch = (rows: Thread[]) => Thread[];
const patches = new Map<number, Patch>();
let patchId = 1;
let seq = 0;
let controller: AbortController | null = null;

function filtered(rows: Thread[], filter: ListFilter): Thread[] {
  if (filter === "unread") return rows.filter((t) => t.unread);
  if (filter === "starred") return rows.filter((t) => t.starred);
  return rows;
}

function patched(rows: Thread[]): Thread[] {
  let out = rows;
  for (const p of patches.values()) out = p(out);
  return out;
}

/** Install new raw rows: reapply pending optimistic patches, keep focus by id, prune selection. */
function commit(raw: Thread[], extra: Partial<ListState> = {}) {
  const s = list.get();
  const rows = patched(raw);
  const visible = filtered(rows, s.filter);
  let focusedId = s.focusedId;
  if (focusedId && !visible.some((t) => t.id === focusedId)) {
    // The focused row left (done elsewhere, another device). Stay at the same index.
    const old = s.visible.findIndex((t) => t.id === focusedId);
    focusedId = visible[Math.min(Math.max(old, 0), visible.length - 1)]?.id ?? null;
  }
  if (!focusedId && visible.length) focusedId = visible[0]!.id;
  let selected = s.selected;
  if (selected.size) {
    const ids = new Set(visible.map((t) => t.id));
    const kept = [...selected].filter((id) => ids.has(id));
    if (kept.length !== selected.size) selected = new Set(kept);
  }
  list.set({ rows: raw, visible, focusedId, selected, ...extra });
}

/** Re-run the patches over the stored raw rows (after a patch is added or released). */
function recompute() {
  const s = list.get();
  commit(s.rows);
}

export function openView(key: string, view: MailView, params: ListParams | null) {
  const s = list.get();
  if (s.key === key && s.status !== "error" && s.status !== "idle") return;
  controller?.abort();
  seq++;
  list.set({
    key,
    view,
    params,
    rows: [],
    visible: [],
    next: null,
    status: params ? "loading" : "idle",
    loadingMore: false,
    error: null,
    focusedId: null,
    selected: new Set(),
    filter: "all",
    resetToken: s.resetToken + 1,
  });
  if (params) void fetchFirst(params, 100);
}

/** A refetch re-reads at most this many rows; anything further down keeps its last known state until scrolled to. */
const REFRESH_CAP = 1000;

async function fetchFirst(params: ListParams, count: number) {
  const mine = ++seq;
  controller?.abort();
  controller = new AbortController();
  try {
    const { rows, next } = await fetchRows(params, Math.min(count, REFRESH_CAP), controller.signal);
    if (mine !== seq) return;
    if (count > REFRESH_CAP && next) {
      const edge = rows[rows.length - 1]!;
      const tail = list.get().rows.filter((t) => t.sortAt < edge.sortAt || (t.sortAt === edge.sortAt && t.id < edge.id));
      commit([...rows, ...tail], { next: tail.length ? list.get().next : next, status: "ready", error: null });
    } else commit(rows, { next, status: "ready", error: null });
  } catch (err) {
    if ((err as Error).name === "AbortError" || mine !== seq) return;
    list.set({ status: "error", error: err instanceof Error ? err.message : "Couldn't load your mail" });
  }
}

async function fetchRows(params: ListParams, count: number, signal: AbortSignal) {
  const rows: Thread[] = [];
  let next: string | null = null;
  while (rows.length < count) {
    const page = await api.threads({ ...params, before: next, limit: Math.min(500, Math.max(count - rows.length, 1)) }, signal);
    rows.push(...page.threads);
    next = page.next;
    if (!next) break;
  }
  return { rows, next };
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let lastReload = 0;

/** Refetch everything loaded so far. Throttled so bursts of events become one request. */
export function reload(immediate = false) {
  const run = () => {
    lastReload = Date.now();
    const s = list.get();
    if (!s.params) return;
    void fetchFirst(s.params, Math.max(s.rows.length, 100));
  };
  clearTimeout(reloadTimer);
  const wait = immediate ? 0 : Math.max(0, 350 - (Date.now() - lastReload));
  reloadTimer = setTimeout(run, wait);
}

export async function loadMore() {
  const s = list.get();
  if (!s.next || s.loadingMore || !s.params || s.status !== "ready") return;
  const mine = seq;
  list.set({ loadingMore: true });
  try {
    const page = await api.threads({ ...s.params, before: s.next, limit: 200 });
    if (mine !== seq) return;
    const have = new Set(list.get().rows.map((t) => t.id));
    commit([...list.get().rows, ...page.threads.filter((t) => !have.has(t.id))], { next: page.next, loadingMore: false });
  } catch (err) {
    if (mine === seq) list.set({ loadingMore: false, error: err instanceof Error ? err.message : null });
  }
}

/** Optimistic change that survives refetches until released. */
export function addPatch(fn: Patch): () => void {
  const id = patchId++;
  patches.set(id, fn);
  recompute();
  return () => {
    if (patches.delete(id)) recompute();
  };
}

/** Change fields on specific rows in place (star, read, labels…). */
export function patchRows(ids: string[], change: Partial<Thread> | ((t: Thread) => Partial<Thread>)): () => void {
  const set = new Set(ids);
  return addPatch((rows) => rows.map((t) => (set.has(t.id) ? { ...t, ...(typeof change === "function" ? change(t) : change) } : t)));
}

export function removeRows(ids: string[]): () => void {
  const set = new Set(ids);
  return addPatch((rows) => rows.filter((t) => !set.has(t.id)));
}

export function setFilter(filter: ListFilter) {
  const s = list.get();
  const next = s.filter === filter ? "all" : filter;
  list.set({ filter: next });
  commit(s.rows);
  if (next !== "all") void ensureFilled();
}

export function clearFilter() {
  const s = list.get();
  if (s.filter === "all") return;
  list.set({ filter: "all" });
  commit(s.rows);
}

async function ensureFilled() {
  for (let i = 0; i < 6; i++) {
    const s = list.get();
    if (s.visible.length >= 30 || !s.next) return;
    await loadMore();
  }
}

// ---- Focus and selection ---------------------------------------------------

export function focusId(id: string | null) {
  list.set({ focusedId: id });
}

export function moveFocus(delta: number, extend = false) {
  const s = list.get();
  if (s.visible.length === 0) return;
  const i = s.focusedId ? s.visible.findIndex((t) => t.id === s.focusedId) : -1;
  const j = Math.min(Math.max((i === -1 ? (delta > 0 ? -1 : 0) : i) + delta, 0), s.visible.length - 1);
  const target = s.visible[j]!;
  if (extend) {
    const sel = new Set(s.selected);
    const from = s.visible[i === -1 ? j : i]!;
    sel.add(from.id);
    sel.add(target.id);
    list.set({ focusedId: target.id, selected: sel });
  } else list.set({ focusedId: target.id });
}

export function focusEdge(end: "top" | "bottom") {
  const s = list.get();
  const t = end === "top" ? s.visible[0] : s.visible[s.visible.length - 1];
  if (t) list.set({ focusedId: t.id });
}

export function toggleSelected(id: string) {
  const sel = new Set(list.get().selected);
  if (sel.has(id)) sel.delete(id);
  else sel.add(id);
  list.set({ selected: sel });
}

export function selectAll() {
  list.set({ selected: new Set(list.get().visible.map((t) => t.id)) });
}

export function clearSelection() {
  if (list.get().selected.size) list.set({ selected: new Set() });
}

/** Rows an action should apply to: the selection if there is one, otherwise the focused row. */
export function targetIds(preferId?: string | null): string[] {
  const s = list.get();
  if (s.selected.size) return [...s.selected];
  const id = preferId ?? s.focusedId;
  return id ? [id] : [];
}

export function threadById(id: string): Thread | undefined {
  return list.get().rows.find((t) => t.id === id);
}

/** Which row should take focus once `ids` leave the list. */
export function advanceTarget(ids: string[], mode: "next" | "previous" | "list"): string | null {
  const s = list.get();
  if (mode === "list") return null;
  const gone = new Set(ids);
  const idx = s.visible.map((t, i) => (gone.has(t.id) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return s.focusedId;
  const first = Math.min(...idx);
  const last = Math.max(...idx);
  const after = s.visible.slice(last + 1).find((t) => !gone.has(t.id));
  const before = s.visible.slice(0, first).reverse().find((t) => !gone.has(t.id));
  return (mode === "next" ? (after ?? before) : (before ?? after))?.id ?? null;
}
