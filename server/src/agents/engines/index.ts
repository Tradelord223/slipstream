import type { AppContext } from "../../context.ts";
import type { EngineAccounts } from "./accounts.ts";
import { apiEngines } from "./api.ts";
import { chatgptEngine } from "./chatgpt.ts";
import type { ChatGPTAuth } from "./chatgpt-auth.ts";
import { cliEngines } from "./cli.ts";
import type { Engine, EngineId } from "./types.ts";

/**
 * Every engine Slipstream can run agents on, except the managed Anthropic agent, which the runner
 * drives itself (its loop runs in Anthropic's cloud, not here). Order is the order people see them in.
 */
export function createEngines(ctx: AppContext, accounts: EngineAccounts, chatgpt: ChatGPTAuth): Map<EngineId, Engine> {
  const api = apiEngines(ctx, accounts);
  const byId = (id: EngineId) => api.find((e) => e.id === id)!;
  const engines: Engine[] = [
    chatgptEngine(chatgpt, accounts),
    byId("loop:anthropic"),
    byId("loop:openai"),
    byId("loop:gemini"),
    byId("loop:openrouter"),
    ...cliEngines(ctx),
  ];
  return new Map(engines.map((e) => [e.id, e]));
}
