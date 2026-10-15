import { useMemo } from "react";
import { plural } from "../../lib/format.ts";
import { threadById, useList } from "../../store/list.ts";
import { useRoute } from "../../store/route.ts";
import { useThread } from "../../store/threads.ts";

export interface ContextChip {
  key: string;
  label: string;
  /** The same thing in a few words, for the reference that rides along with a follow-up. */
  short: string;
  threadIds: string[];
  kind: "thread" | "selection";
}

/** What the person is looking at: the open conversation, or the rows they've selected. */
export function useAssistantContext(): ContextChip[] {
  const route = useRoute();
  const selected = useList((s) => s.selected);
  const openId = route.name === "thread" ? route.id : null;
  const { detail } = useThread(openId);
  return useMemo(() => {
    if (openId) {
      const subject = (detail?.thread ?? threadById(openId))?.subject;
      return [{ key: `thread:${openId}`, kind: "thread" as const, threadIds: [openId], label: `This conversation${subject ? `: ${subject}` : ""}`, short: subject || "a conversation" }];
    }
    if (route.name === "mail" && selected.size > 0) {
      const ids = [...selected];
      return [{ key: `selection:${ids.join(",")}`, kind: "selection" as const, threadIds: ids, label: `${plural(ids.length, "conversation")} selected`, short: plural(ids.length, "selected conversation") }];
    }
    return [];
  }, [openId, detail, route.name, selected]);
}
