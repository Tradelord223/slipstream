import { api } from "../api.ts";
import { categoryName } from "../lib/sorting.ts";
import type { Category, Sorting } from "../types.ts";
import { refreshCounts } from "./counts.ts";
import { createStore, useStore } from "./createStore.ts";
import { reload } from "./list.ts";
import { invalidate } from "./threads.ts";
import { toast } from "./toasts.ts";

/** The two small dialogs that start from a conversation: move its sender's mail, or make a split from it. */
export type SortingDialog = { kind: "move" | "split"; threadId: string } | null;

const dialog = createStore<{ open: SortingDialog }>({ open: null });
export const useSortingDialog = () => useStore(dialog, (s) => s.open);
export const openMoveMenu = (threadId: string) => dialog.set({ open: { kind: "move", threadId } });
export const openNewSplit = (threadId: string) => dialog.set({ open: { kind: "split", threadId } });
export const closeSortingDialog = () => dialog.set({ open: null });

export type Scope = "sender" | "domain" | "list";

/** What a correction would name, in words: "Humble Bundle", "humblebundle.com", "news.humblebundle.com". */
export function scopeLabel(scope: Scope, s: Sorting): string {
  if (scope === "domain") return s.domain ?? "this company";
  if (scope === "list") return s.listId ?? "this mailing list";
  return s.sender?.name || s.sender?.email || "this sender";
}

/** After mail moves tabs (or a move is undone): refetch what's on screen. */
function refresh(threadId: string) {
  invalidate([threadId]);
  reload(true);
  refreshCounts(true);
}

/**
 * Send a conversation's sender, domain or mailing list to a tab for good. Throws the server's message when it is refused
 * (the dialog shows it); on success a toast offers Undo, which removes or restores the correction.
 */
export async function moveMail(threadId: string, scope: Scope, category: Category, sorting: Sorting): Promise<void> {
  const res = await api.recategorize(category, { threadId, scope });
  refresh(threadId);
  const moved = res.result.moved;
  const who = scopeLabel(scope, sorting);
  const where = categoryName(category);
  const text =
    moved > 0
      ? `Moved ${moved === 1 ? "1 conversation" : `${moved.toLocaleString("en-US")} conversations`} from ${who} to ${where}`
      : `Mail from ${who} now goes to ${where}`;
  const activityId = res.activityId;
  if (!activityId) {
    toast.info(text);
    return;
  }
  toast.undoable(text, () => {
    api.undoActivity(activityId).then(() => refresh(threadId), (err: Error) => toast.error(err.message || "Couldn't undo that"));
  });
}
