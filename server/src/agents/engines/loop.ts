import { MAX_TOOL_CALLS_PER_TURN, type RunIO, type ToolDef, type TurnOutcome } from "./types.ts";

/**
 * The local tool loop shared by every API engine. Slipstream runs the loop itself: the model gets the
 * agent's commands as function tools, and each call goes through the command registry via io.callTool.
 * Adapters only translate between this loop and one provider's wire format.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface StepResult {
  /** What the model said this step (may be empty when it only calls tools). */
  text: string;
  calls: ToolCall[];
  /** Why the model stopped: it wants tool results, it's finished, or it can't go on. */
  stop: "tool_use" | "end" | "refusal" | "length";
  usage?: { inputTokens: number; outputTokens: number; costCents?: number };
}

/** A provider's wire format. `S` is the conversation as that provider wants it replayed; it must be JSON. */
export interface ModelAdapter<S> {
  init(): S;
  addUser(state: S, text: string): void;
  /** One model call over the conversation so far. Appends the model's own output to `state`. */
  step(state: S, io: RunIO): Promise<StepResult>;
  addResults(state: S, results: { call: ToolCall; text: string; isError: boolean }[]): void;
}

/** A provider-specific failure worth a clear message (bad key, plan limit, …). */
export class EngineError extends Error {
  kind: "auth" | "limit" | "unavailable" | "bad_request";
  constructor(kind: EngineError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export async function runLoop<S>(io: RunIO, adapter: ModelAdapter<S>, message: string): Promise<TurnOutcome> {
  const state = io.loadState<S>() ?? adapter.init();
  adapter.addUser(state, message);
  io.saveState(state);
  let calls = 0;
  try {
    for (;;) {
      if (io.signal.aborted) return { outcome: "done" };
      const res = await adapter.step(state, io);
      io.saveState(state);
      if (res.usage) io.addUsage(res.usage.inputTokens, res.usage.outputTokens);
      if (res.usage?.costCents) io.addCost(res.usage.costCents);
      if (res.text.trim()) io.say(res.text.trim());
      if (res.stop === "refusal") return { outcome: "failed", error: "The model declined this task." };
      // A response cut off mid-way may hold half-written tool inputs: never run those.
      if (res.stop === "length") {
        if (res.calls.length) {
          adapter.addResults(state, res.calls.map((call) => ({ call, text: "Not run: the request was cut off.", isError: true })));
          io.saveState(state);
        }
        return { outcome: "failed", error: "The model ran out of room to answer." };
      }
      if (!res.calls.length) return { outcome: "done" };
      if (calls + res.calls.length > MAX_TOOL_CALLS_PER_TURN) {
        adapter.addResults(state, res.calls.map((call) => ({ call, text: "Not run: this turn reached its tool-call limit.", isError: true })));
        io.saveState(state);
        return { outcome: "limit", error: `Stopped after ${MAX_TOOL_CALLS_PER_TURN} tool calls. Send a follow-up to let it continue.` };
      }
      const results = [];
      for (const call of res.calls) {
        if (io.signal.aborted) break;
        const r = await io.callTool(call.name, call.input);
        results.push({ call, text: r.text, isError: r.isError });
        calls += 1;
      }
      // Every call needs an answer, even when stopped mid-way, so the saved conversation stays valid.
      for (const call of res.calls.slice(results.length)) results.push({ call, text: "Stopped by the user.", isError: true });
      adapter.addResults(state, results);
      io.saveState(state);
    }
  } catch (err) {
    if (io.signal.aborted) return { outcome: "done" };
    if (err instanceof EngineError && err.kind === "limit") return { outcome: "limit", error: err.message };
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tool schemas without the keys some providers reject. */
export function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema;
  return rest;
}

export function toolList(tools: ToolDef[]): ToolDef[] {
  return tools.map((t) => ({ ...t, parameters: cleanSchema(t.parameters) }));
}

/** Read a server-sent-events body as { event, data } pairs. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
