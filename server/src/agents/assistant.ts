import type { AppContext } from "../context.ts";
import { PROVIDERS } from "./engines/accounts.ts";

/**
 * The built-in assistant's on/off switch, as the server enforces it. Off stops what Slipstream runs on its own
 * (Autopilot, routines, assistant chats). Agents the person connects themselves (MCP, the API, the CLI) are not
 * part of it: that's bring your own agent.
 */

/**
 * Until someone picks on/off, the assistant follows whether they've set up a model: a default engine or model,
 * a saved or environment key, a ChatGPT sign-in, the cloud agent, or any agent run.
 */
function assistantDefault(ctx: AppContext, userId: string): "on" | "off" {
  const { db } = ctx;
  const engines = db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = 'engines'", userId);
  const prefs = engines ? (JSON.parse(engines.value) as { defaultEngine?: string; models?: object }) : {};
  const configured =
    Boolean(prefs.defaultEngine) ||
    Object.keys(prefs.models ?? {}).length > 0 ||
    PROVIDERS.some((p) => ctx.cloud.accounts.keySource(userId, p)) ||
    Boolean(db.get("SELECT 1 AS x FROM settings WHERE user_id = ? AND (key LIKE 'secret:%' OR key = 'cloudAgent')", userId)) ||
    Boolean(db.get("SELECT 1 AS x FROM cloud_runs WHERE user_id = ? LIMIT 1", userId));
  return configured ? "on" : "off";
}

/** The effective setting: the person's explicit choice, else on once a model is set up. The dashboard and every gate read this. */
export function assistantSetting(ctx: AppContext, userId: string): "on" | "off" {
  const row = ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = 'assistant'", userId);
  if (row) {
    try {
      const chosen: unknown = JSON.parse(row.value);
      if (chosen === "on" || chosen === "off") return chosen;
    } catch {
      /* a value that isn't JSON is no choice at all */
    }
  }
  return assistantDefault(ctx, userId);
}

export const assistantEnabled = (ctx: AppContext, userId: string): boolean => assistantSetting(ctx, userId) === "on";
