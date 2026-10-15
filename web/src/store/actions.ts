import { api } from "../api.ts";
import { leavesView } from "../lib/views.ts";
import { formatWhen } from "../lib/when.ts";
import type { Thread, TriageKind } from "../types.ts";
import { refreshCounts } from "./counts.ts";
import { advanceTarget, clearSelection, focusId, list, patchRows, reload, removeRows, targetIds, threadById } from "./list.ts";
import { getRoute, navigate, routeFrom } from "./route.ts";
import { refreshSession, session } from "./session.ts";
import { cachedThread, invalidate, patchCachedThread } from "./threads.ts";
import { toast } from "./toasts.ts";
import { openRemind, showTip, type Tip } from "./ui.ts";

export interface ActionOpts {
  /** The user clicked rather than pressed a key; teach the shortcut. */
  mouse?: boolean;
  ids?: string[];
}

/** The conversations an action applies to right now. */
export function currentTargets(explicit?: string[]): string[] {
  if (explicit?.length) return explicit;
  const route = getRoute();
  if (route.name === "thread") return [route.id];
  return targetIds();
}

function threadFor(id: string): Thread | undefined {
  return threadById(id) ?? cachedThread(id)?.thread;
}

interface Run {
  kind: TriageKind;
  ids: string[];
  label?: string;
  until?: number;
  text: string;
  patch?: Partial<Thread> | ((t: Thread) => Partial<Thread>);
  tip?: Tip;
  mouse?: boolean;
  silent?: boolean;
}

const count = (ids: string[], one: string) => (ids.length > 1 ? `${ids.length} conversations ${one.toLowerCase()}` : one);

/** Take conversations out of the visible list right away and move focus (or the open thread) along. */
export function removeLocally(ids: string[]): () => void {
  const route = getRoute();
  const target = advanceTarget(ids, session.get().settings.autoAdvance);
  if (route.name === "thread") {
    const from = routeFrom();
    if (target) navigate(`/t/${target}`, { replace: true, from });
    else if (from) history.back();
    else navigate("/");
  }
  if (target) focusId(target);
  return removeRows(ids);
}

async function run(r: Run) {
  const { ids } = r;
  if (ids.length === 0) return;
  const view = list.get().view;
  const labelView = view?.kind === "label" && r.kind === "removeLabel" ? view.name.toLowerCase() === (r.label ?? "").toLowerCase() : true;
  const removes = view ? leavesView(view, r.kind) && labelView : false;

  let release: () => void;
  if (removes) release = removeLocally(ids);
  else if (r.patch) release = patchRows(ids, r.patch);
  else release = () => {};
  if (r.patch && typeof r.patch !== "function") patchCachedThread(ids, r.patch);
  clearSelection();

  try {
    const res = await api.triage(r.kind, ids, { until: r.until, label: r.label });
    if (!r.silent) {
      toast.undoable(r.text, () => void undo(res.undoToken, ids));
      if (r.mouse && r.tip) showTip(r.tip);
    }
    invalidate(ids);
    if (r.kind === "addLabel") void refreshSession();
    setTimeout(() => {
      release();
      reload(true);
      refreshCounts();
    }, 500);
  } catch (err) {
    release();
    toast.error(err instanceof Error ? err.message : "That didn't go through");
    reload(true);
  }
}

export async function undo(token: string, ids: string[]) {
  try {
    await api.undo(token);
    invalidate(ids);
    if (ids[0]) focusId(ids[0]);
    reload(true);
    refreshCounts(true);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't undo that");
  }
}

const tip = (id: string, text: string, key: string): Tip => ({ id, text, key });

export const act = {
  done(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({ kind: "done", ids, text: count(ids, "Done"), mouse: o.mouse, tip: tip("done", "Next time, press", "E") });
  },
  notDone(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({ kind: "undone", ids, text: count(ids, "Moved to inbox"), patch: { inInbox: true } });
  },
  trash(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({ kind: "trash", ids, text: count(ids, "Moved to trash"), mouse: o.mouse, tip: tip("trash", "Next time, press", "#") });
  },
  spam(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({ kind: "spam", ids, text: count(ids, "Marked as spam") });
  },
  mute(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({ kind: "mute", ids, text: count(ids, "Muted") });
  },
  star(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    const all = ids.every((id) => threadFor(id)?.starred);
    return run({
      kind: all ? "unstar" : "star",
      ids,
      text: all ? "Star removed" : "Starred",
      patch: { starred: !all },
      mouse: o.mouse,
      tip: tip("star", "Next time, press", "S"),
    });
  },
  toggleRead(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    const allUnread = ids.every((id) => threadFor(id)?.unread);
    return run({ kind: allUnread ? "read" : "unread", ids, text: allUnread ? "Marked read" : "Marked unread", patch: { unread: !allUnread } });
  },
  markRead(ids: string[]) {
    return run({ kind: "read", ids, text: "", patch: { unread: false }, silent: true });
  },
  remindAt(ids: string[], at: Date, opts: { mouse?: boolean } = {}) {
    return run({
      kind: "snooze",
      ids,
      until: at.getTime(),
      text: `Reminder set · ${formatWhen(at)}`,
      patch: { snoozedUntil: at.getTime() },
      mouse: opts.mouse,
      tip: tip("remind", "Next time, press", "H"),
    });
  },
  /** Open the Remind Me popover for the current conversations. */
  remind(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    if (ids.length === 0) return;
    openRemind({ title: ids.length > 1 ? `Remind me about ${ids.length} conversations` : "Remind me", onPick: (at) => void act.remindAt(ids, at, { mouse: o.mouse }) });
  },
  clearReminder(o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({ kind: "unsnooze", ids, text: count(ids, "Reminder cleared"), patch: { snoozedUntil: null } });
  },
  addLabel(name: string, o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({
      kind: "addLabel",
      ids,
      label: name,
      text: `Labeled ${name}`,
      patch: (t) => ({ labels: t.labels.some((l) => l.toLowerCase() === name.toLowerCase()) ? t.labels : [...t.labels, name] }),
    });
  },
  removeLabel(name: string, o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    return run({
      kind: "removeLabel",
      ids,
      label: name,
      text: `Removed ${name}`,
      patch: (t) => ({ labels: t.labels.filter((l) => l.toLowerCase() !== name.toLowerCase()) }),
    });
  },
  /** Label it and take it out of the inbox in one undoable step. */
  async moveToLabel(name: string, o: ActionOpts = {}) {
    const ids = currentTargets(o.ids);
    await run({ kind: "addLabel", ids, label: name, text: `Moved to ${name}`, patch: (t) => ({ labels: [...t.labels, name] }), silent: true });
    return run({ kind: "done", ids, text: `Moved to ${name}` });
  },
};
