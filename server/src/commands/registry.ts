import type { z } from "zod";
import type { Agent, Scope } from "../agents/agents.ts";
import type { User } from "../auth/users.ts";
import type { AppContext } from "../context.ts";

/**
 * Slipstream's single action vocabulary. The HTTP API (/api/v1), MCP tools, the CLI and the
 * dashboard's command palette are all generated from these definitions, so they can't drift.
 */

export type Actor = { kind: "human"; user: User } | { kind: "agent"; user: User; agent: Agent };

export const actorName = (a: Actor) => (a.kind === "agent" ? a.agent.name : a.user.name);

export interface CommandOutcome {
  result: unknown;
  /** One line for the activity log, e.g. `Marked "Q3 plan" done`. */
  summary?: string;
  threadIds?: string[];
  /** Precise undo within the triage window. */
  undoToken?: string | null;
  /** The command that reverses this one, used once the precise window has passed. */
  inverse?: { command: string; input: unknown } | null;
}

export interface Command<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: S;
  /** For one principal's own use (Autopilot's decisions): listed only to actors this accepts. */
  visibleTo?: (ctx: AppContext, actor: Actor) => boolean;
  /** Reads don't change anything and aren't recorded as activity. */
  readOnly?: boolean;
  /** When an agent calls this, return why a person must approve it first (or null to run now). */
  approval?: (ctx: AppContext, actor: Extract<Actor, { kind: "agent" }>, input: z.output<S>) => string | null;
  /** What the person sees in the Review queue. */
  preview?: (ctx: AppContext, actor: Actor, input: z.output<S>) => string;
  run: (ctx: AppContext, actor: Actor, input: z.output<S>) => Promise<CommandOutcome> | CommandOutcome;
}

export function defineCommand<S extends z.ZodType>(c: Command<S>): Command {
  return c as unknown as Command;
}
