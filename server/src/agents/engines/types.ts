import type { Agent } from "../agents.ts";
import type { User } from "../../auth/users.ts";

/**
 * Engines are the models (and the accounts behind them) that can power Slipstream's agents.
 * Every engine works only through Slipstream's command registry, so scopes, approvals, attribution
 * and undo are the same whichever model is thinking.
 */

export type EngineId =
  | "managed:anthropic"
  | "loop:chatgpt"
  | "loop:openai"
  | "loop:anthropic"
  | "loop:gemini"
  | "loop:openrouter"
  | "cli:claude-code"
  | "cli:codex";

export const ENGINE_IDS: EngineId[] = [
  "managed:anthropic",
  "loop:chatgpt",
  "loop:openai",
  "loop:anthropic",
  "loop:gemini",
  "loop:openrouter",
  "cli:claude-code",
  "cli:codex",
];

export type EngineKind = "managed" | "loop" | "cli";

export interface EngineStatus {
  id: EngineId;
  label: string;
  kind: EngineKind;
  /** Can start a run right now. */
  ready: boolean;
  /** One line for people: "Signed in as ana@…", "Add an API key", "Codex isn't installed". */
  detail: string;
  /** What's missing, when not ready. */
  needs?: "key" | "signin" | "install" | "login";
  /** Models this account can use, newest/best first, when the provider lists them. */
  models?: string[];
  /** The model runs will use. */
  model?: string | null;
  /** "api": billed to an API account (only some providers report the dollar cost); "plan": draws on a plan's own limits (sign-ins, CLIs). */
  billing: "api" | "plan";
  /** Anything a person should know before choosing it (terms, sandboxing). */
  note?: string;
  /** The signed-in account, for sign-in engines. */
  account?: { email?: string; plan?: string };
  /** A sign-in is waiting to be finished in the browser. */
  pending?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** Everything an engine needs for one turn; implemented by the runner. */
export interface RunIO {
  runId: string;
  userId: string;
  actor: { kind: "agent"; user: User; agent: Agent };
  /** The model chosen for this run (null: the engine's default). */
  model: string | null;
  systemPrompt: string;
  /** Slipstream's commands this agent may use, as function tools. */
  tools: ToolDef[];
  /** Run one tool call through the command registry (scopes, approvals, attribution, undo). */
  callTool(name: string, input: unknown): Promise<ToolResult>;
  /** Text the agent says to the person. */
  say(text: string): void;
  /** A tool call happened (for engines whose tools run outside callTool, like the CLIs). */
  toolLine(name: string, failed: boolean): void;
  /** Something worth showing that isn't the agent talking (warnings, errors). */
  note(text: string): void;
  /** Engine-private conversation state, persisted with the run so follow-ups and restarts continue it. */
  loadState<T>(): T | null;
  saveState(state: unknown): void;
  /** Add to the run's cost in US cents, when the provider reports one. */
  addCost(cents: number): void;
  /** Add tokens the model used, when the provider reports them. */
  addUsage(inputTokens: number, outputTokens: number): void;
  /** A run-scoped bearer token for Slipstream's own /mcp (CLI engines). Revoked when the run ends. */
  mcpAccess(): { url: string; token: string };
  signal: AbortSignal;
}

export type TurnOutcome = { outcome: "done" } | { outcome: "failed"; error: string } | { outcome: "limit"; error: string };

export interface Engine {
  id: EngineId;
  label: string;
  kind: EngineKind;
  status(userId: string): Promise<EngineStatus>;
  /** One turn: the first instruction, or a follow-up. Resolves when the agent is done answering it. */
  turn(io: RunIO, message: string): Promise<TurnOutcome>;
}

/** Most turns are short; this stops a confused model from looping forever. */
export const MAX_TOOL_CALLS_PER_TURN = 25;
/** Tool results are capped before they go back to a model. */
export const MAX_TOOL_RESULT_CHARS = 100_000;
