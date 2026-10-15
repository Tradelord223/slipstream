import { api } from "../api.ts";
import { removeLocally, undo } from "./actions.ts";
import { refreshCounts } from "./counts.ts";
import { clearSelection, focusId, list, reload } from "./list.ts";
import { currentUrl, getRoute, navigate, routeFrom, viewPath, type MailView } from "./route.ts";
import { toast } from "./toasts.ts";
import { ui } from "./ui.ts";

/** Open a conversation from the list; Esc returns to the same mailbox. */
export function openThread(id: string) {
  const route = getRoute();
  focusId(id);
  if (route.name === "thread") navigate(`/t/${id}`, { replace: true, from: routeFrom() });
  else navigate(`/t/${id}`, { from: currentUrl() });
  ui.set({ sheetOpen: false });
}

/** Leave a conversation for the list. */
export function closeThread() {
  if (getRoute().name !== "thread") return;
  if (routeFrom()) history.back();
  else navigate("/", { replace: true });
}

export function goView(view: MailView) {
  clearSelection();
  ui.set({ sheetOpen: false });
  navigate(viewPath(view));
}

export async function unsubscribeFrom(ids: string[]) {
  const id = ids[0];
  if (!id) return;
  try {
    const res = await api.unsubscribe(id);
    if (res.method === "web" && res.url) {
      window.open(res.url, "_blank", "noopener,noreferrer");
      toast.undoable("Opened the unsubscribe page · Done", () => void undo(res.undoToken, [id]));
    } else toast.undoable("Unsubscribed", () => void undo(res.undoToken, [id]));
    removeLocally([id]);
    reload(true);
    refreshCounts();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "This sender didn't include an unsubscribe link.");
  }
}

export async function getMeToZero(opts: { olderThanDays: number; keepStarred: boolean }, label: string) {
  try {
    const res = await api.zero({ ...opts, keepUnread: false });
    if (!res.undoToken) {
      toast.info("Nothing to clear");
      return;
    }
    const token = res.undoToken;
    toast.undoable(`${label} · ${res.threadIds.length} conversations done`, () => void undo(token, res.threadIds), 10_000);
    list.set({ focusedId: null });
    reload(true);
    refreshCounts(true);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Couldn't clear your inbox");
  }
}
