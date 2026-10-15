import type { AppContext } from "../../context.ts";
import type { EngineAccounts, Provider } from "./accounts.ts";
import { anthropicAdapter, anthropicClient } from "./adapters/anthropic-messages.ts";
import { chatCompletionsAdapter } from "./adapters/chat-completions.ts";
import { responsesAdapter } from "./adapters/openai-responses.ts";
import { runLoop, type ModelAdapter } from "./loop.ts";
import type { Engine, EngineId, EngineStatus } from "./types.ts";

/**
 * The API-key engines: OpenAI, Claude, Gemini and OpenRouter. Each runs Slipstream's own tool loop
 * with a provider adapter, billed to the person's key.
 */

const MODELS_TTL_MS = 10 * 60 * 1000;
/** A provider that can't list models is retried after a minute, not on every status check. */
const MODELS_RETRY_MS = 60 * 1000;
const LIST_TIMEOUT_MS = 8000;

interface Spec {
  id: EngineId;
  label: string;
  provider: Provider;
  envVar: string;
  /** Models to pick as the default, best first, when the provider's list has them. */
  prefer: string[];
  /** Used when the list is unavailable or has none of the preferred models. */
  fallback: string;
  list(key: string): Promise<string[]>;
  adapter(key: string, model: string): ModelAdapter<any>;
}

// Read at call time so tests can point each engine at a local stand-in.
const base = (name: string, fallback: string) => (process.env[name] || fallback).replace(/\/+$/, "");
const openaiBase = () => base("SLIPSTREAM_OPENAI_BASE_URL", "https://api.openai.com/v1");
const geminiBase = () => base("SLIPSTREAM_GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai");
const openrouterBase = () => base("SLIPSTREAM_OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");

async function getJson<T>(url: string, key: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Listing models failed (${res.status}).`);
  return (await res.json()) as T;
}

const NOT_FOR_CHAT = /audio|realtime|image|embedding|tts|transcribe|search|moderation|instruct|deep-research/;

const SPECS: Spec[] = [
  {
    id: "loop:openai",
    label: "OpenAI API",
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    prefer: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
    fallback: "gpt-6.1-sol",
    async list(key) {
      const { data } = await getJson<{ data: { id: string; created?: number }[] }>(`${openaiBase()}/models`, key);
      return data
        .filter((m) => /^(gpt-|o\d)/.test(m.id) && !NOT_FOR_CHAT.test(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id);
    },
    adapter: (key, model) => responsesAdapter({ baseUrl: openaiBase(), token: async () => key, model, chatgpt: false }),
  },
  {
    id: "loop:anthropic",
    label: "Claude API",
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    prefer: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"],
    fallback: "claude-opus-5-5",
    async list(key) {
      const page = await anthropicClient(key, process.env.SLIPSTREAM_ANTHROPIC_BASE_URL).models.list({ limit: 100 }, { timeout: LIST_TIMEOUT_MS, maxRetries: 0 });
      // Agents ask for adaptive thinking, which older models reject.
      return page.data.filter((m) => !m.capabilities || m.capabilities.thinking.types.adaptive.supported).map((m) => m.id);
    },
    adapter: (key, model) => anthropicAdapter({ apiKey: key, baseUrl: process.env.SLIPSTREAM_ANTHROPIC_BASE_URL, model }),
  },
  {
    id: "loop:gemini",
    label: "Gemini",
    provider: "gemini",
    envVar: "GEMINI_API_KEY",
    // Google's compatibility docs use gemini-3.8-flash throughout; gemini-4-argon is the pricier flagship, one pick away.
    prefer: ["gemini-3.8-flash", "gemini-4-argon", "gemini-3.6-flash"],
    fallback: "gemini-3.8-flash",
    async list(key) {
      const { data } = await getJson<{ data: { id: string }[] }>(`${geminiBase()}/models`, key);
      return data.map((m) => m.id.replace(/^models\//, "")).filter((id) => id.startsWith("gemini-") && !/tts|live|image|transcribe|embedding|audio|translate|omni|robotics|nano-banana/.test(id));
    },
    adapter: (key, model) => chatCompletionsAdapter({ provider: "Gemini", baseUrl: geminiBase(), apiKey: key, model }),
  },
  {
    id: "loop:openrouter",
    label: "OpenRouter",
    provider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    prefer: ["anthropic/claude-opus-5.5", "openai/gpt-6.1-sol", "google/gemini-3.8-flash"],
    fallback: "anthropic/claude-opus-5.5",
    async list(key) {
      const { data } = await getJson<{ data: { id: string }[] }>(`${openrouterBase()}/models?supported_parameters=tools`, key);
      // Batch variants aren't for live chat, and free ones may train on what they're sent: mail stays out.
      return data.map((m) => m.id).filter((id) => !id.endsWith(":batch") && !id.endsWith(":free"));
    },
    adapter: (key, model) => chatCompletionsAdapter({ provider: "OpenRouter", baseUrl: openrouterBase(), apiKey: key, model }),
  },
];

export function apiEngines(_ctx: AppContext, accounts: EngineAccounts): Engine[] {
  const cache = new Map<string, { at: number; key: string; models: string[] | null }>();

  /** The provider's models for this person, newest first; null when it can't say right now. */
  async function models(spec: Spec, userId: string, key: string): Promise<string[] | null> {
    const id = `${userId}:${spec.provider}`;
    const hit = cache.get(id);
    if (hit && hit.key === key && Date.now() - hit.at < (hit.models ? MODELS_TTL_MS : MODELS_RETRY_MS)) return hit.models;
    const list = await spec.list(key).catch(() => null);
    cache.set(id, { at: Date.now(), key, models: list?.length ? list : null });
    return list?.length ? list : null;
  }

  async function defaultModel(spec: Spec, userId: string, key: string): Promise<string> {
    const saved = accounts.model(userId, spec.id);
    if (saved) return saved;
    const list = await models(spec, userId, key);
    return spec.prefer.find((m) => list?.includes(m)) ?? spec.fallback;
  }

  return SPECS.map((spec): Engine => ({
    id: spec.id,
    label: spec.label,
    kind: "loop",
    async status(userId) {
      const common = { id: spec.id, label: spec.label, kind: "loop", billing: "api" } as const;
      const key = accounts.key(userId, spec.provider);
      if (!key) return { ...common, ready: false, needs: "key", detail: "Add an API key", model: accounts.model(userId, spec.id) ?? spec.fallback } satisfies EngineStatus;
      const list = await models(spec, userId, key);
      return {
        ...common,
        ready: true,
        detail: accounts.keySource(userId, spec.provider) === "saved" ? "Using your saved key" : `Using ${spec.envVar} from the server's environment`,
        ...(list ? { models: list } : {}),
        model: await defaultModel(spec, userId, key),
      } satisfies EngineStatus;
    },
    async turn(io, message) {
      const key = accounts.key(io.userId, spec.provider);
      if (!key) return { outcome: "failed", error: `Add your ${spec.label} key first.` };
      const model = io.model ?? (await defaultModel(spec, io.userId, key));
      return runLoop(io, spec.adapter(key, model), message);
    },
  }));
}
