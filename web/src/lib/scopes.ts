import type { AgentScope } from "../types.ts";

export const SCOPE_INFO: { id: AgentScope; label: string; hint: string }[] = [
  { id: "read", label: "Read", hint: "Search and read mail, drafts and activity" },
  { id: "triage", label: "Triage", hint: "Mark done, star, label, remind, trash and unsubscribe" },
  { id: "draft", label: "Draft", hint: "Write and edit drafts and share with your team. Nothing is sent." },
  { id: "send", label: "Send", hint: "Send drafts as you, now or later" },
  { id: "settings", label: "Settings", hint: "Change your splits and add snippets" },
];

export const scopeLabel = (s: AgentScope) => SCOPE_INFO.find((x) => x.id === s)?.label ?? s;

/** "read, triage and draft". */
export function scopeSentence(scopes: AgentScope[]): string {
  const names = SCOPE_INFO.filter((s) => scopes.includes(s.id)).map((s) => s.label.toLowerCase());
  if (names.length === 0) return "nothing yet";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
