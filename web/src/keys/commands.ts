import { act } from "../store/actions.ts";
import { decide, focusedApproval, moveReviewFocus, openCreateAgent, openRelated, review, threadOf } from "../store/agents.ts";
import { closeCompose, compose, discardDraft, edit, emitCompose, getEditor, instantIntro, sendCompose, sendLater, startNew, startReply } from "../store/compose.ts";
import { clearFilter, clearSelection, focusEdge, list, loadMore, moveFocus, selectAll, setFilter, targetIds, toggleSelected } from "../store/list.ts";
import { closeThread, goView, openThread, unsubscribeFrom } from "../store/nav.ts";
import { getRoute, navigate } from "../store/route.ts";
import { session, setAccountFilter } from "../store/session.ts";
import { cachedThread, loadThread } from "../store/threads.ts";
import { moveMessage, toggleExpandAll, toggleFocusedMessage } from "../store/threadView.ts";
import { toast, undoLast } from "../store/toasts.ts";
import { closePalette, openPalette, toggleContext, toggleRail, ui } from "../store/ui.ts";
import type { ComposeKind } from "../lib/compose.ts";

export type Scope = "global" | "list" | "thread" | "compose" | "page" | "review";

export interface CommandDef {
  id: string;
  title: string;
  group: string;
  /** Default bindings. A space separates the keys of a chord. */
  keys: string[];
  scopes: Scope[];
  run: () => void;
  /** Hidden from the palette and the sheet when this returns false. */
  when?: () => boolean;
  /** Holding the key repeats the command. */
  repeat?: boolean;
  /** Only fires when focus is on the page or the list, so Tab keeps moving through controls. */
  needsListFocus?: boolean;
  /** Not offered in the command palette (kept for the shortcut sheet). */
  noPalette?: boolean;
}

const hasAi = () => session.get().features.ai;

function focusedThreadId(): string | null {
  const r = getRoute();
  return r.name === "thread" ? r.id : list.get().focusedId;
}

async function reply(kind: Exclude<ComposeKind, "new">) {
  const id = focusedThreadId();
  if (!id) return;
  if (!cachedThread(id)) await loadThread(id);
  const detail = cachedThread(id);
  if (!detail) {
    toast.error("Couldn't open that conversation");
    return;
  }
  startReply(detail, kind, getRoute().name === "thread");
}

function page(direction: 1 | -1) {
  const r = getRoute();
  if (r.name === "thread") {
    const el = document.querySelector<HTMLElement>("[data-thread-scroll]");
    el?.scrollBy({ top: direction * el.clientHeight * 0.85 });
    return;
  }
  const rows = Math.max(Math.floor((document.querySelector<HTMLElement>("[data-list-root]")?.clientHeight ?? 600) / 40) - 1, 1);
  moveFocus(direction * rows);
}

function cycleSplit(direction: 1 | -1) {
  const r = getRoute();
  const splits = session.get().splits;
  if (r.name !== "mail" || r.view.kind !== "inbox" || splits.length < 2) return;
  const cur = splits.findIndex((s) => s.id === (r.view.kind === "inbox" ? r.view.splitId : undefined));
  const next = splits[(Math.max(cur, 0) + direction + splits.length) % splits.length]!;
  goView({ kind: "inbox", splitId: next.id });
}

function removeLabel() {
  const v = list.get().view;
  if (v?.kind === "label") void act.removeLabel(v.name);
  else {
    const ids = targetIds(focusedThreadId());
    openPalette("removeLabel", ids);
  }
}

function format(cmd: string) {
  getEditor()?.focus();
  document.execCommand(cmd);
}

function switchAccount(n: number) {
  const accounts = session.get().accounts;
  if (n === 1) setAccountFilter(null);
  else {
    const a = accounts[n - 2];
    if (a) setAccountFilter(a.id);
  }
}

const goto = (id: string, title: string, key: string, run: () => void): CommandDef => ({
  id: `go.${id}`,
  title,
  group: "Go to",
  keys: [`g ${key}`],
  scopes: ["list", "thread", "page"],
  run,
});

export const COMMANDS: CommandDef[] = [
  // ---- Moving around
  { id: "nav.next", title: "Next conversation", group: "Move", keys: ["j"], scopes: ["list", "thread"], repeat: true, run: () => stepConversation(1) },
  { id: "nav.prev", title: "Previous conversation", group: "Move", keys: ["k"], scopes: ["list", "thread"], repeat: true, run: () => stepConversation(-1) },
  { id: "nav.nextArrow", title: "Next conversation", group: "Move", keys: ["down"], scopes: ["list"], repeat: true, noPalette: true, run: () => stepConversation(1) },
  { id: "nav.prevArrow", title: "Previous conversation", group: "Move", keys: ["up"], scopes: ["list"], repeat: true, noPalette: true, run: () => stepConversation(-1) },
  { id: "nav.top", title: "Jump to top", group: "Move", keys: ["mod+up"], scopes: ["list"], run: () => focusEdge("top") },
  { id: "nav.bottom", title: "Jump to bottom", group: "Move", keys: ["mod+down"], scopes: ["list"], run: () => focusEdge("bottom") },
  { id: "nav.pageDown", title: "Page down", group: "Move", keys: ["space"], scopes: ["list", "thread"], run: () => page(1), noPalette: true },
  { id: "nav.pageUp", title: "Page up", group: "Move", keys: ["shift+space"], scopes: ["list", "thread"], run: () => page(-1), noPalette: true },
  { id: "msg.next", title: "Next message", group: "Move", keys: ["n"], scopes: ["thread"], repeat: true, run: () => moveMessage(1) },
  { id: "msg.prev", title: "Previous message", group: "Move", keys: ["p"], scopes: ["thread"], repeat: true, run: () => moveMessage(-1) },
  { id: "thread.open", title: "Open conversation", group: "Move", keys: ["enter"], scopes: ["list"], run: () => { const id = list.get().focusedId; if (id) openThread(id); }, noPalette: true },
  { id: "thread.back", title: "Back to list", group: "Move", keys: ["escape"], scopes: ["thread"], run: closeThread },
  { id: "list.escape", title: "Clear selection", group: "Move", keys: ["escape"], scopes: ["list"], run: () => { if (list.get().selected.size) clearSelection(); else clearFilter(); }, noPalette: true },
  { id: "msg.expand", title: "Expand or collapse message", group: "Move", keys: ["o"], scopes: ["thread"], run: toggleFocusedMessage },
  { id: "msg.expandAll", title: "Expand or collapse all messages", group: "Move", keys: ["shift+o"], scopes: ["thread"], run: toggleExpandAll },

  // ---- Review queue
  { id: "review.next", title: "Next request", group: "Review", keys: ["j"], scopes: ["review"], repeat: true, run: () => moveReviewFocus(1) },
  { id: "review.prev", title: "Previous request", group: "Review", keys: ["k"], scopes: ["review"], repeat: true, run: () => moveReviewFocus(-1) },
  { id: "review.nextArrow", title: "Next request", group: "Review", keys: ["down"], scopes: ["review"], repeat: true, noPalette: true, run: () => moveReviewFocus(1) },
  { id: "review.prevArrow", title: "Previous request", group: "Review", keys: ["up"], scopes: ["review"], repeat: true, noPalette: true, run: () => moveReviewFocus(-1) },
  { id: "review.approve", title: "Approve", group: "Review", keys: ["enter"], scopes: ["review"], run: () => { const a = focusedApproval(); if (a && review.get().tab === "waiting") void decide(a, "approve"); } },
  { id: "review.reject", title: "Reject", group: "Review", keys: ["backspace"], scopes: ["review"], run: () => { const a = focusedApproval(); if (a && review.get().tab === "waiting") void decide(a, "reject"); } },
  { id: "review.open", title: "Open the conversation", group: "Review", keys: ["e"], scopes: ["review"], run: () => { const a = focusedApproval(); if (a && threadOf(a)) openRelated(a); } },

  // ---- Triage
  { id: "triage.done", title: "Mark done", group: "Triage", keys: ["e"], scopes: ["list", "thread"], run: () => void act.done() },
  { id: "triage.undone", title: "Move back to inbox", group: "Triage", keys: ["shift+e"], scopes: ["list", "thread"], run: () => void act.notDone() },
  { id: "triage.remind", title: "Remind me…", group: "Triage", keys: ["h"], scopes: ["list", "thread"], run: () => act.remind() },
  { id: "triage.star", title: "Star or unstar", group: "Triage", keys: ["s"], scopes: ["list", "thread"], run: () => void act.star() },
  { id: "triage.read", title: "Mark read or unread", group: "Triage", keys: ["u"], scopes: ["list", "thread"], run: () => void act.toggleRead() },
  { id: "triage.trash", title: "Move to trash", group: "Triage", keys: ["#"], scopes: ["list", "thread"], run: () => void act.trash() },
  { id: "triage.spam", title: "Report spam", group: "Triage", keys: ["!"], scopes: ["list", "thread"], run: () => void act.spam() },
  { id: "triage.mute", title: "Mute conversation", group: "Triage", keys: ["shift+m"], scopes: ["list", "thread"], run: () => void act.mute() },
  { id: "triage.unsubscribe", title: "Unsubscribe", group: "Triage", keys: ["mod+u"], scopes: ["list", "thread"], run: () => void unsubscribeFrom(targetIds(focusedThreadId())) },
  { id: "triage.clearReminder", title: "Clear reminder", group: "Triage", keys: [], scopes: ["list", "thread"], run: () => void act.clearReminder() },
  { id: "triage.label", title: "Label…", group: "Triage", keys: ["l"], scopes: ["list", "thread"], run: () => openPalette("label", targetIds(focusedThreadId())) },
  { id: "triage.removeLabel", title: "Remove label", group: "Triage", keys: ["y"], scopes: ["list", "thread"], run: removeLabel },
  { id: "triage.move", title: "Move to…", group: "Triage", keys: ["v"], scopes: ["list", "thread"], run: () => openPalette("move", targetIds(focusedThreadId())) },
  { id: "list.select", title: "Select conversation", group: "Select", keys: ["x"], scopes: ["list"], run: () => { const id = list.get().focusedId; if (id) toggleSelected(id); } },
  { id: "list.extendDown", title: "Extend selection down", group: "Select", keys: ["shift+j"], scopes: ["list"], repeat: true, run: () => moveFocus(1, true) },
  { id: "list.extendUp", title: "Extend selection up", group: "Select", keys: ["shift+k"], scopes: ["list"], repeat: true, run: () => moveFocus(-1, true) },
  { id: "list.selectAll", title: "Select all", group: "Select", keys: ["mod+a"], scopes: ["list"], run: selectAll },
  { id: "list.filterUnread", title: "Show only unread", group: "Select", keys: ["shift+u"], scopes: ["list"], run: () => setFilter("unread") },
  { id: "list.filterStarred", title: "Show only starred", group: "Select", keys: ["shift+s"], scopes: ["list"], run: () => setFilter("starred") },
  { id: "undo", title: "Undo", group: "Triage", keys: ["z"], scopes: ["list", "thread", "page"], run: () => { if (!undoLast()) toast.info("Nothing to undo", 1800); } },

  // ---- Write
  { id: "compose.new", title: "Compose", group: "Write", keys: ["c"], scopes: ["list", "thread", "page"], run: () => startNew() },
  { id: "compose.reply", title: "Reply", group: "Write", keys: ["r"], scopes: ["list", "thread"], run: () => void reply("reply") },
  { id: "compose.replyAll", title: "Reply all", group: "Write", keys: ["enter"], scopes: ["thread"], run: () => void reply("replyAll") },
  { id: "compose.replyAllList", title: "Reply all", group: "Write", keys: [], scopes: ["list"], run: () => void reply("replyAll") },
  { id: "compose.forward", title: "Forward", group: "Write", keys: ["f"], scopes: ["list", "thread"], run: () => void reply("forward") },

  { id: "send", title: "Send", group: "Compose", keys: ["mod+enter"], scopes: ["compose"], run: () => void sendCompose(), when: () => compose.get().open },
  { id: "send.done", title: "Send and mark done", group: "Compose", keys: ["mod+shift+enter"], scopes: ["compose"], run: () => void sendCompose({ markDone: true }), when: () => compose.get().open && Boolean(compose.get().threadId) },
  { id: "send.now", title: "Send instantly", group: "Compose", keys: ["mod+shift+z"], scopes: ["compose"], run: () => void sendCompose({ instant: true }), when: () => compose.get().open },
  { id: "send.later", title: "Send later…", group: "Compose", keys: ["mod+shift+l"], scopes: ["compose"], run: sendLater, when: () => compose.get().open },
  { id: "compose.discard", title: "Discard draft", group: "Compose", keys: ["mod+shift+,"], scopes: ["compose"], run: () => void discardDraft(), when: () => compose.get().open },
  { id: "compose.close", title: "Close and keep draft", group: "Compose", keys: ["escape"], scopes: ["compose"], run: () => void closeCompose(), noPalette: true },
  { id: "compose.cc", title: "Add Cc", group: "Compose", keys: ["mod+shift+c"], scopes: ["compose"], run: () => edit({ showCc: true }), when: () => compose.get().open },
  { id: "compose.bcc", title: "Add Bcc", group: "Compose", keys: ["mod+shift+b"], scopes: ["compose"], run: () => edit({ showBcc: true }), when: () => compose.get().open },
  { id: "compose.from", title: "Change From account", group: "Compose", keys: ["mod+shift+f"], scopes: ["compose"], run: () => emitCompose("from"), when: () => compose.get().open && session.get().accounts.length > 1 },
  { id: "compose.attach", title: "Attach files", group: "Compose", keys: ["mod+shift+u"], scopes: ["compose"], run: () => emitCompose("attach"), when: () => compose.get().open },
  { id: "compose.pop", title: "Pop out or dock", group: "Compose", keys: ["mod+shift+p"], scopes: ["compose"], run: () => compose.set((s) => ({ mode: s.mode === "modal" ? "dock" : "modal", inline: false })), when: () => compose.get().open },
  { id: "compose.intro", title: "Instant Intro", group: "Compose", keys: ["mod+shift+i"], scopes: ["compose"], run: () => void instantIntro(), when: () => compose.get().open && Boolean(compose.get().threadId) },
  { id: "compose.snippets", title: "Insert snippet…", group: "Compose", keys: ["mod+;"], scopes: ["compose"], run: () => emitCompose("snippets"), when: () => compose.get().open },
  { id: "compose.ai", title: "Write with AI", group: "Compose", keys: ["mod+j"], scopes: ["compose"], run: () => emitCompose("ai"), when: () => hasAi() && compose.get().open },
  { id: "format.bold", title: "Bold", group: "Compose", keys: ["mod+b"], scopes: ["compose"], run: () => format("bold"), when: () => compose.get().open },
  { id: "format.italic", title: "Italic", group: "Compose", keys: ["mod+i"], scopes: ["compose"], run: () => format("italic"), when: () => compose.get().open },
  { id: "format.underline", title: "Underline", group: "Compose", keys: ["mod+u"], scopes: ["compose"], run: () => format("underline"), when: () => compose.get().open },
  { id: "format.link", title: "Insert link", group: "Compose", keys: ["mod+k"], scopes: ["compose"], run: () => emitCompose("link"), when: () => compose.get().open },
  { id: "format.bullets", title: "Bulleted list", group: "Compose", keys: ["mod+shift+8"], scopes: ["compose"], run: () => format("insertUnorderedList"), when: () => compose.get().open },
  { id: "format.numbers", title: "Numbered list", group: "Compose", keys: ["mod+shift+7"], scopes: ["compose"], run: () => format("insertOrderedList"), when: () => compose.get().open },

  // ---- Everywhere
  { id: "palette", title: "Command palette", group: "General", keys: ["mod+k"], scopes: ["global"], run: () => (ui.get().palette ? closePalette() : openPalette()), noPalette: true },
  { id: "search", title: "Search", group: "General", keys: ["/"], scopes: ["list", "thread"], run: () => ui.set({ searchOpen: true, sheetOpen: false }) },
  { id: "shortcuts", title: "Keyboard shortcuts", group: "General", keys: ["?"], scopes: ["list", "thread", "page"], run: () => ui.set({ shortcuts: true }) },
  { id: "rail.toggle", title: "Toggle sidebar", group: "General", keys: ["\\"], scopes: ["list", "thread", "page"], run: toggleRail },
  { id: "context.toggle", title: "Toggle contact pane", group: "General", keys: [], scopes: ["thread"], run: toggleContext },
  { id: "settings", title: "Settings", group: "General", keys: ["mod+,"], scopes: ["global"], run: () => navigate("/settings/general") },
  { id: "split.next", title: "Next split", group: "Move", keys: ["tab"], scopes: ["list"], needsListFocus: true, run: () => cycleSplit(1) },
  { id: "split.prev", title: "Previous split", group: "Move", keys: ["shift+tab"], scopes: ["list"], needsListFocus: true, run: () => cycleSplit(-1) },

  goto("inbox", "Go to Inbox", "i", () => goView({ kind: "inbox" })),
  goto("done", "Go to Done", "e", () => goView({ kind: "done" })),
  goto("reminders", "Go to Reminders", "h", () => goView({ kind: "reminders" })),
  goto("sent", "Go to Sent", "t", () => goView({ kind: "sent" })),
  goto("drafts", "Go to Drafts", "d", () => goView({ kind: "drafts" })),
  goto("starred", "Go to Starred", "s", () => goView({ kind: "starred" })),
  goto("label", "Go to label…", "l", () => openPalette("goLabel")),
  goto("snippets", "Go to Snippets", ";", () => navigate("/settings/snippets")),
  goto("all", "Go to All mail", "a", () => goView({ kind: "search", q: "in:all" })),
  goto("review", "Go to Review", "r", () => navigate("/review")),
  { id: "go.activity", title: "Go to Activity", group: "Go to", keys: [], scopes: ["list", "thread", "page"], run: () => navigate("/activity") },
  { id: "go.agents", title: "Go to Agents", group: "Go to", keys: [], scopes: ["list", "thread", "page"], run: () => navigate("/settings/agents") },
  { id: "agents.create", title: "Create agent token", group: "General", keys: [], scopes: ["global"], run: openCreateAgent },

  ...Array.from({ length: 9 }, (_, i): CommandDef => ({
    id: `account.${i + 1}`,
    title: i === 0 ? "Switch to all inboxes" : `Switch to account ${i + 1}`,
    group: "Accounts",
    keys: [`ctrl+${i + 1}`],
    scopes: ["global"],
    noPalette: true,
    when: () => i === 0 || Boolean(session.get().accounts[i - 1]),
    run: () => switchAccount(i + 1),
  })),
];

/** j/k: in the list move focus; in a conversation open the neighbouring one. */
function stepConversation(delta: number) {
  const r = getRoute();
  if (r.name !== "thread") {
    moveFocus(delta);
    return;
  }
  const rows = list.get().visible;
  const i = rows.findIndex((t) => t.id === r.id);
  const next = rows[i + delta];
  if (!next) {
    if (delta > 0) void loadMore();
    return;
  }
  list.set({ focusedId: next.id });
  navigate(`/t/${next.id}`, { replace: true, from: history.state?.from ?? null });
}
export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));
