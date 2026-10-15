import { useMemo } from "react";
import { api, ApiError } from "../api.ts";
import type { LabelInfo, LabelRule } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";
import { reload } from "./list.ts";
import { refreshSession, useSession } from "./session.ts";
import { toast } from "./toasts.ts";

interface LabelState {
  /** null until the server answers. */
  labels: LabelInfo[] | null;
  /** False on a server that has no label commands; the rail then shows plain names. */
  supported: boolean;
  rules: LabelRule[] | null;
  /** Parent paths whose children are folded away. */
  collapsed: ReadonlySet<string>;
}

const readCollapsed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem("ss-labels-collapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

export const labelStore = createStore<LabelState>({ labels: null, supported: true, rules: null, collapsed: readCollapsed() });

export const parentOf = (name: string): string | null => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : null);
export const leafOf = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

let timer: ReturnType<typeof setTimeout> | undefined;

/** Coalesces bursts (a bulk label touches many events) into one request. */
export function refreshLabels(immediate = false) {
  clearTimeout(timer);
  timer = setTimeout(() => void loadLabels(), immediate ? 0 : 700);
}

async function loadLabels() {
  try {
    const labels = await api.labels();
    labelStore.set({ labels, supported: true });
  } catch (err) {
    // An older server has no label commands; fall back to the names the session knows.
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) labelStore.set({ supported: false });
    else if (!labelStore.get().labels) labelStore.set({ supported: false });
  }
}

export async function loadRules() {
  try {
    labelStore.set({ rules: await api.labelRules() });
  } catch {
    labelStore.set({ rules: labelStore.get().rules ?? [] });
  }
}

/** Every label with its colour and counts: from the server when it has them, otherwise just the names. */
export function useLabels(): LabelInfo[] {
  const labels = useStore(labelStore, (s) => s.labels);
  const names = useSession((s) => s.labels);
  return useMemo(() => labels ?? names.map((name) => ({ name, color: null, count: 0, unread: 0, parent: parentOf(name) })), [labels, names]);
}

export const useLabelsSupported = () => useStore(labelStore, (s) => s.supported);

const NO_COLORS = new Map<string, string>();
const colorCache = new WeakMap<LabelInfo[], Map<string, string>>();

/** name (lower case) -> colour; one shared map per answer from the server, so rows don't each build their own. */
export function useLabelColors(): Map<string, string> {
  const labels = useStore(labelStore, (s) => s.labels);
  if (!labels) return NO_COLORS;
  let map = colorCache.get(labels);
  if (!map) {
    map = new Map(labels.filter((l) => l.color).map((l) => [l.name.toLowerCase(), l.color!]));
    colorCache.set(labels, map);
  }
  return map;
}

export function toggleCollapsed(path: string) {
  const next = new Set(labelStore.get().collapsed);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  labelStore.set({ collapsed: next });
  try {
    localStorage.setItem("ss-labels-collapsed", JSON.stringify([...next]));
  } catch {
    /* ignore */
  }
}

// ---- Tree -----------------------------------------------------------------------------------

export interface LabelNode {
  path: string;
  name: string;
  label: LabelInfo | null;
  children: LabelNode[];
  unread: number;
}

/** "Clients/Kettleby" nests under "Clients", which needn't exist as a label of its own. */
export function buildTree(labels: LabelInfo[]): LabelNode[] {
  const roots: LabelNode[] = [];
  const byPath = new Map<string, LabelNode>();
  const node = (path: string): LabelNode => {
    let n = byPath.get(path.toLowerCase());
    if (n) return n;
    n = { path, name: leafOf(path), label: null, children: [], unread: 0 };
    byPath.set(path.toLowerCase(), n);
    const parent = parentOf(path);
    (parent ? node(parent).children : roots).push(n);
    return n;
  };
  for (const l of [...labels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) node(l.name).label = l;
  const total = (n: LabelNode): number => (n.unread = (n.label?.unread ?? 0) + n.children.reduce((sum, c) => sum + total(c), 0));
  roots.forEach(total);
  const sort = (list: LabelNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

// ---- Presets ----------------------------------------------------------------------------------

/** Twelve colours that read on both the dark and the light panel. */
export const LABEL_COLORS: { name: string; hex: string }[] = [
  { name: "Red", hex: "#e5484d" },
  { name: "Orange", hex: "#f76b15" },
  { name: "Yellow", hex: "#d9a31b" },
  { name: "Lime", hex: "#7fb135" },
  { name: "Green", hex: "#30a46c" },
  { name: "Teal", hex: "#12a594" },
  { name: "Cyan", hex: "#1ba1c9" },
  { name: "Blue", hex: "#3e8bff" },
  { name: "Indigo", hex: "#6e56cf" },
  { name: "Purple", hex: "#ab4aba" },
  { name: "Pink", hex: "#d6409f" },
  { name: "Gray", hex: "#8b8d98" },
];

// ---- Actions ------------------------------------------------------------------------------------

async function run<T>(name: string, input: unknown, done: string): Promise<T | undefined> {
  try {
    const res = await api.command<T>(name, input);
    toast.info(done);
    return res.result;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "That didn't go through");
    throw err;
  } finally {
    refreshLabels(true);
    void refreshSession();
  }
}

/** Show a change at once and let the server's answer replace it. */
function optimistic(fn: (labels: LabelInfo[]) => LabelInfo[]) {
  const prev = labelStore.get().labels;
  if (prev) labelStore.set({ labels: fn(prev) });
  return () => labelStore.set({ labels: prev });
}

export async function createLabel(name: string, color: string | null) {
  const undo = optimistic((ls) => [...ls, { name, color, count: 0, unread: 0, parent: parentOf(name) }]);
  try {
    await run("labels.create", color ? { name, color } : { name }, `Created ${name}`);
  } catch (err) {
    undo();
    throw err;
  }
}

export async function renameLabel(name: string, newName: string) {
  const undo = optimistic((ls) => ls.map((l) => (l.name === name ? { ...l, name: newName, parent: parentOf(newName) } : l)));
  try {
    await run("labels.update", { name, newName }, `Renamed to ${newName}`);
    reload(true);
  } catch (err) {
    undo();
    throw err;
  }
}

export async function recolorLabel(name: string, color: string | null) {
  const undo = optimistic((ls) => ls.map((l) => (l.name === name ? { ...l, color } : l)));
  try {
    await run("labels.update", { name, color }, "Color changed");
  } catch (err) {
    undo();
    throw err;
  }
}

export async function deleteLabel(name: string) {
  const undo = optimistic((ls) => ls.filter((l) => l.name !== name));
  try {
    await run("labels.delete", { name }, `Deleted ${name}`);
    reload(true);
  } catch (err) {
    undo();
    throw err;
  }
}

export async function createRule(label: string, query: string, applyToExisting: boolean) {
  await run("labelRules.create", { label, query, applyToExisting }, applyToExisting ? "Rule added and applied" : "Rule added");
  await loadRules();
  if (applyToExisting) reload(true);
}

export async function updateRule(id: string, patch: Partial<Pick<LabelRule, "label" | "query" | "enabled">>, quiet = false) {
  const prev = labelStore.get().rules;
  if (prev) labelStore.set({ rules: prev.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  try {
    if (quiet) await api.command("labelRules.update", { id, ...patch });
    else await run("labelRules.update", { id, ...patch }, "Rule saved");
  } catch (err) {
    labelStore.set({ rules: prev });
    if (quiet) toast.error(err instanceof Error ? err.message : "That didn't go through");
    throw err;
  }
}

export async function deleteRule(id: string) {
  const prev = labelStore.get().rules;
  if (prev) labelStore.set({ rules: prev.filter((r) => r.id !== id) });
  try {
    await run("labelRules.delete", { id }, "Rule deleted");
  } catch (err) {
    labelStore.set({ rules: prev });
    throw err;
  }
}

