import type { ListParams } from "../api.ts";
import type { Split } from "../types.ts";
import type { MailView } from "../store/route.ts";
import { defaultSplit } from "./sorting.ts";

/** The query the server needs for a mailbox. null means the view isn't a thread list (drafts). */
export function viewParams(view: MailView, splits: Split[], account: string | null): ListParams | null {
  const base = account ? { account } : {};
  switch (view.kind) {
    case "inbox": {
      const split = splits.find((s) => s.id === view.splitId) ?? defaultSplit(splits);
      if (!split) return { view: "inbox", ...base };
      return { view: "split", split: split.id, ...base };
    }
    case "reminders": return { view: "search", q: "in:snoozed", ...base };
    case "done": return { view: "search", q: "in:done", ...base };
    case "sent": return { view: "search", q: "in:sent", ...base };
    case "starred": return { view: "search", q: "is:starred", ...base };
    case "label": return { view: "search", q: `label:"${view.name.replace(/"/g, "")}"`, ...base };
    case "search": return { view: "search", q: view.q, ...base };
    case "drafts": return null;
  }
}

export function viewTitle(view: MailView, splits: Split[]): string {
  switch (view.kind) {
    case "inbox": return (splits.find((s) => s.id === view.splitId) ?? defaultSplit(splits))?.name ?? "Inbox";
    case "reminders": return "Reminders";
    case "done": return "Done";
    case "sent": return "Sent";
    case "drafts": return "Drafts";
    case "starred": return "Starred";
    case "label": return view.name;
    case "search": return view.q ? `Search: ${view.q}` : "Search";
  }
}

/** Triage kinds that take a conversation out of the current mailbox. */
export function leavesView(view: MailView, kind: string): boolean {
  switch (view.kind) {
    case "inbox":
      return ["done", "trash", "spam", "snooze", "mute"].includes(kind);
    case "reminders":
      return ["unsnooze", "done", "trash", "spam"].includes(kind);
    case "done":
      return ["undone", "trash", "spam", "snooze"].includes(kind);
    case "starred":
      return ["unstar", "trash", "spam"].includes(kind);
    case "label":
      return ["removeLabel", "trash", "spam"].includes(kind);
    case "sent":
    case "search":
      return ["trash", "spam"].includes(kind);
    case "drafts":
      return false;
  }
}
