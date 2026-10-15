import type { AppContext } from "../../context.ts";
import type { Agent, Scope } from "../agents.ts";
import type { EngineId } from "./types.ts";

/**
 * Models & accounts: the API keys and sign-ins that power agents, sealed at rest like mail credentials,
 * plus each engine's chosen model and the agent principal it acts as.
 */

export const PROVIDERS = ["openai", "anthropic", "gemini", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const DEFAULT_SCOPES: Scope[] = ["read", "triage", "draft", "send"];

interface Prefs {
  /** The engine new runs use when none is named. */
  defaultEngine?: EngineId;
  models?: Partial<Record<EngineId, string>>;
  principals?: Partial<Record<EngineId, string>>;
}

export class EngineAccounts {
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  private getSetting(userId: string, key: string): string | null {
    return this.ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = ?", userId, key)?.value ?? null;
  }

  private setSetting(userId: string, key: string, value: string | null) {
    if (value === null) this.ctx.db.run("DELETE FROM settings WHERE user_id = ? AND key = ?", userId, key);
    else
      this.ctx.db.run(
        "INSERT INTO settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
        userId,
        key,
        value,
      );
  }

  /** A sealed value (API key, sign-in tokens). */
  secret<T>(userId: string, name: string): T | null {
    const raw = this.getSetting(userId, `secret:${name}`);
    return raw ? this.ctx.secrets.open<T>(JSON.parse(raw) as string) : null;
  }

  setSecret(userId: string, name: string, value: unknown | null) {
    this.setSetting(userId, `secret:${name}`, value === null ? null : JSON.stringify(this.ctx.secrets.seal(value)));
  }

  /** The user's own key, else the server's environment (local installs and single-tenant hosts). */
  key(userId: string, provider: Provider): string | null {
    return this.secret<string>(userId, provider) ?? this.envKey(provider);
  }

  envKey(provider: Provider): string | null {
    const c = this.ctx.config;
    const fromEnv = { openai: c.openaiApiKey, anthropic: c.anthropicApiKey, gemini: c.geminiApiKey, openrouter: c.openrouterApiKey }[provider];
    return fromEnv ?? null;
  }

  /** Where a key comes from, for the UI: never the key itself. */
  keySource(userId: string, provider: Provider): "saved" | "environment" | null {
    if (this.getSetting(userId, `secret:${provider}`)) return "saved";
    return this.envKey(provider) ? "environment" : null;
  }

  setKey(userId: string, provider: Provider, key: string | null) {
    this.setSecret(userId, provider, key === null ? null : key.trim());
  }

  private prefs(userId: string): Prefs {
    const raw = this.getSetting(userId, "engines");
    return raw ? (JSON.parse(raw) as Prefs) : {};
  }

  private savePrefs(userId: string, p: Prefs) {
    this.setSetting(userId, "engines", JSON.stringify(p));
  }

  defaultEngine(userId: string): EngineId | null {
    return this.prefs(userId).defaultEngine ?? null;
  }

  setDefaultEngine(userId: string, id: EngineId) {
    this.savePrefs(userId, { ...this.prefs(userId), defaultEngine: id });
  }

  model(userId: string, id: EngineId): string | null {
    return this.prefs(userId).models?.[id] ?? null;
  }

  setModel(userId: string, id: EngineId, model: string | null) {
    const p = this.prefs(userId);
    const models = { ...p.models };
    if (model) models[id] = model;
    else delete models[id];
    this.savePrefs(userId, { ...p, models });
  }

  /** The principal an engine acts as, created on first use and named after it, so Review and Activity say who acted. */
  principal(userId: string, id: EngineId, label: string): Agent {
    const p = this.prefs(userId);
    const existing = p.principals?.[id] ? this.ctx.agents.get(userId, p.principals[id]!) : null;
    if (existing) return existing;
    const { agent } = this.ctx.agents.create(userId, label, DEFAULT_SCOPES);
    this.savePrefs(userId, { ...p, principals: { ...p.principals, [id]: agent.id } });
    return agent;
  }

  /** The principal if it exists, without creating one. */
  existingPrincipal(userId: string, id: EngineId): Agent | null {
    const pid = this.prefs(userId).principals?.[id];
    return pid ? this.ctx.agents.get(userId, pid) : null;
  }
}
