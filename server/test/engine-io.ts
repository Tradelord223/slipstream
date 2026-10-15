import type { RunIO, ToolDef, ToolResult } from "../src/agents/engines/types.ts";

/**
 * A scripted RunIO for testing an engine on its own: tools answer from a table, and everything the
 * engine reports (speech, tool lines, notes, state, cost) is recorded for assertions.
 */
export interface FakeIO extends RunIO {
  said: string[];
  notes: string[];
  toolLines: { name: string; failed: boolean }[];
  calls: { name: string; input: unknown }[];
  cents: number;
  state: unknown;
  abort(): void;
}

export const SAMPLE_TOOLS: ToolDef[] = [
  {
    name: "mail_search",
    description: "Search mail with Gmail-style operators.",
    parameters: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "drafts_create",
    description: "Create a draft reply.",
    parameters: { type: "object", properties: { threadId: { type: "string" }, body: { type: "string" } }, required: ["threadId", "body"] },
  },
  {
    name: "drafts_send",
    description: "Send a draft. May wait for the user's approval.",
    parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
  },
];

export function fakeIO(opts: {
  tools?: ToolDef[];
  answers?: Record<string, (input: unknown) => ToolResult | string>;
  model?: string | null;
  state?: unknown;
  mcp?: { url: string; token: string };
}): FakeIO {
  const ctl = new AbortController();
  const io: FakeIO = {
    runId: "run_test",
    userId: "usr_test",
    actor: { kind: "agent", user: { id: "usr_test", name: "Ana Reyes", email: "ana@fernpoint.co" } as never, agent: { id: "agt_test", name: "Test" } as never },
    model: opts.model ?? null,
    systemPrompt: "You are a test assistant.",
    tools: opts.tools ?? SAMPLE_TOOLS,
    said: [],
    notes: [],
    toolLines: [],
    calls: [],
    cents: 0,
    state: opts.state ?? null,
    async callTool(name, input) {
      io.calls.push({ name, input });
      const answer = opts.answers?.[name];
      if (!answer) return { text: `Unknown tool ${name}`, isError: true };
      const r = answer(input);
      return typeof r === "string" ? { text: r, isError: false } : r;
    },
    say: (t) => void io.said.push(t),
    toolLine: (name, failed) => void io.toolLines.push({ name, failed }),
    note: (t) => void io.notes.push(t),
    loadState: <T>() => (io.state === null ? null : (JSON.parse(JSON.stringify(io.state)) as T)),
    saveState: (s) => void (io.state = JSON.parse(JSON.stringify(s))),
    addCost: (c) => void (io.cents += c),
    mcpAccess: () => opts.mcp ?? { url: "http://127.0.0.1:1/mcp", token: "ss_oat_test" },
    signal: ctl.signal,
    abort: () => ctl.abort(),
  };
  return io;
}
