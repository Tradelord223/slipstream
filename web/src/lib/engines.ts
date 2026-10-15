import type { EngineId, EngineStatus } from "../types.ts";
import { modelName } from "../store/cloud.ts";

export interface EngineGroup {
  id: "plans" | "keys" | "managed";
  title: string;
  ids: EngineId[];
}

/** How Models & accounts groups the eight engines, in display order. */
export const ENGINE_GROUPS: EngineGroup[] = [
  { id: "plans", title: "Your plans", ids: ["loop:chatgpt", "cli:claude-code", "cli:codex"] },
  { id: "keys", title: "API keys", ids: ["loop:anthropic", "loop:openai", "loop:gemini", "loop:openrouter"] },
  { id: "managed", title: "Managed", ids: ["managed:anthropic"] },
];

export const KEY_PROVIDER = {
  "loop:anthropic": "anthropic",
  "loop:openai": "openai",
  "loop:gemini": "gemini",
  "loop:openrouter": "openrouter",
} as const;

export const KEY_LINKS: Record<string, { name: string; url: string; placeholder: string }> = {
  anthropic: { name: "Anthropic", url: "https://console.anthropic.com/settings/keys", placeholder: "sk-ant-…" },
  openai: { name: "OpenAI", url: "https://platform.openai.com/api-keys", placeholder: "sk-…" },
  gemini: { name: "Google AI Studio", url: "https://aistudio.google.com/apikey", placeholder: "AI…" },
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/keys", placeholder: "sk-or-…" },
};

/** "gpt-6.1-sol" stays as it is; Claude ids read as "Claude Opus 5.5"; vendor prefixes drop off OpenRouter ids. */
export function shortModel(id: string | null | undefined): string {
  if (!id) return "";
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return modelName(bare);
}

/** What to call the assistant in sentences: "Ask ChatGPT", "Codex is working…". */
const ASSISTANT_NAME: Record<EngineId, string> = {
  "managed:anthropic": "Claude",
  "loop:chatgpt": "ChatGPT",
  "loop:anthropic": "Claude",
  "loop:openai": "OpenAI",
  "loop:gemini": "Gemini",
  "loop:openrouter": "OpenRouter",
  "cli:claude-code": "Claude Code",
  "cli:codex": "Codex",
};

export const assistantName = (id: EngineId | null | undefined): string => (id ? ASSISTANT_NAME[id] : "Assistant");

/** The label on the picker: "OpenAI API · gpt-6.1-sol". */
export function engineLine(e: Pick<EngineStatus, "label" | "model">): string {
  return e.model ? `${e.label} · ${shortModel(e.model)}` : e.label;
}
