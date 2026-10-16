import type { CloudRun, TranscriptEntry } from "../types.ts";

export type Block = { kind: "p"; text: string } | { kind: "ul"; items: string[] };

/** The agent writes plain text with "- " bullets: paragraphs stay paragraphs, runs of bullets become one list. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let items: string[] | null = null;
  const flushPara = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (items) out.push({ kind: "ul", items });
    items = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      (items ??= []).push(bullet[1]!);
    } else if (!line) {
      flushPara();
      flushList();
    } else if (items && /^\s/.test(raw)) {
      // A wrapped bullet continues on an indented line.
      items[items.length - 1] += ` ${line}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out;
}

const PHRASE: Record<string, string> = {
  "mail.search": "Searched your mail",
  "mail.searchAll": "Searched all your mail at its provider",
  "mail.list": "Looked through a list of conversations",
  "mail.read": "Read a conversation",
  "mail.unsubscribe": "Unsubscribed from a sender",
  "triage.done": "Marked conversations done",
  "triage.inbox": "Moved conversations back to the inbox",
  "triage.remind": "Set a reminder",
  "triage.cancelReminder": "Cancelled a reminder",
  "triage.star": "Starred conversations",
  "triage.unstar": "Removed a star",
  "triage.markRead": "Marked conversations read",
  "triage.markUnread": "Marked conversations unread",
  "triage.mute": "Muted conversations",
  "triage.unmute": "Unmuted conversations",
  "triage.label": "Added a label",
  "triage.unlabel": "Removed a label",
  "triage.trash": "Moved conversations to the trash",
  "triage.untrash": "Restored conversations",
  "triage.spam": "Reported spam",
  "triage.notSpam": "Moved conversations out of spam",
  "drafts.create": "Wrote a draft",
  "drafts.update": "Edited a draft",
  "drafts.delete": "Discarded a draft",
  "drafts.send": "Asked to send a draft",
  "drafts.cancelSend": "Cancelled a send",
  "team.share": "Shared a conversation with the team",
  "team.comment": "Commented for the team",
  "labels.list": "Looked at your labels",
  "labels.create": "Created a label",
  "labels.update": "Changed a label",
  "labels.delete": "Deleted a label",
};

/** A transcript tool line is the command name, optionally followed by " (failed)". */
export function parseTool(text: string): { name: string; failed: boolean; phrase: string } {
  const failed = / \(failed\)$/.test(text);
  const name = text.replace(/ \(failed\)$/, "");
  const phrase = PHRASE[name] ?? `Used ${name}`;
  return { name, failed, phrase };
}

export type Turn =
  | { kind: "user"; text: string; at: number }
  | { kind: "agent"; text: string; at: number }
  | { kind: "tools"; entries: TranscriptEntry[] }
  | { kind: "note"; text: string; at: number };

/** Consecutive tool calls collapse into one group so a long search doesn't drown the answer. */
export function turns(run: CloudRun): Turn[] {
  const out: Turn[] = [];
  for (const e of run.transcript) {
    if (e.kind === "tool") {
      const last = out.at(-1);
      if (last?.kind === "tools") last.entries.push(e);
      else out.push({ kind: "tools", entries: [e] });
    } else out.push({ kind: e.kind, text: e.text, at: e.at });
  }
  return out;
}

export function runText(run: CloudRun): string {
  return `${run.instruction}\n${run.transcript.filter((e) => e.kind === "agent" || e.kind === "user").map((e) => e.text).join("\n")}`.toLowerCase();
}

export interface RunGroup {
  label: string;
  runs: CloudRun[];
}

export function groupRuns(runs: CloudRun[], now = Date.now()): RunGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86_400_000;
  const buckets: RunGroup[] = [
    { label: "Today", runs: [] },
    { label: "Yesterday", runs: [] },
    { label: "Previous 7 days", runs: [] },
    { label: "Older", runs: [] },
  ];
  for (const r of runs) {
    if (r.createdAt >= today) buckets[0]!.runs.push(r);
    else if (r.createdAt >= today - day) buckets[1]!.runs.push(r);
    else if (r.createdAt >= today - 7 * day) buckets[2]!.runs.push(r);
    else buckets[3]!.runs.push(r);
  }
  return buckets.filter((b) => b.runs.length > 0);
}

const CONTEXT = /\n*\[context: ([^|\]]*) \| ([^\]]*)\]/g;

/** A follow-up carries what the person was looking at as "[context: Subject | id,id]"; show it as chips instead. */
export function splitContext(text: string): { text: string; context: { label: string; ids: string[] }[] } {
  const context: { label: string; ids: string[] }[] = [];
  const clean = text.replace(CONTEXT, (_m, label: string, ids: string) => {
    context.push({ label: label.trim(), ids: ids.split(",").map((s) => s.trim()).filter(Boolean) });
    return "";
  });
  return { text: clean.trim(), context };
}

export function contextMarker(label: string, ids: string[]): string {
  return `[context: ${label.replace(/[|\]\n]/g, " ").trim()} | ${ids.join(",")}]`;
}
