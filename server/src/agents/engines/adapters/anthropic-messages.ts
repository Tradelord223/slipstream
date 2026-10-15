import Anthropic from "@anthropic-ai/sdk";
import { EngineError, toolList, type ModelAdapter, type ToolCall } from "../loop.ts";

/**
 * Anthropic's Messages API through the official SDK. The model's whole reply (thinking blocks included)
 * is replayed unchanged on the next step, and tool results go back as tool_result blocks.
 */

export interface AnthropicState {
  messages: Anthropic.MessageParam[];
}

export interface AnthropicOptions {
  apiKey: string;
  /** Only set for tests against a local stand-in. */
  baseUrl?: string;
  model: string;
}

const MAX_TOKENS = 16_000;
/** A paused turn is resumed by sending it back; this stops a model that keeps pausing. */
const MAX_RESUMES = 5;
/** Tool input the SDK can't parse at all (eager input streaming skips the server's check) is asked for again, a few times. */
const MAX_BAD_JSON = 2;

export function anthropicClient(apiKey: string, baseUrl?: string): Anthropic {
  return new Anthropic({ apiKey, baseURL: baseUrl || undefined, maxRetries: 2 });
}

export function anthropicAdapter(opts: AnthropicOptions): ModelAdapter<AnthropicState> {
  const client = anthropicClient(opts.apiKey, opts.baseUrl);
  return {
    init: () => ({ messages: [] }),

    addUser(state, text) {
      // A turn that ended mid-call (a refusal) leaves tool_use blocks unanswered, which the API rejects.
      const last = state.messages[state.messages.length - 1];
      const open = last?.role === "assistant" && Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_use") : [];
      const content: Anthropic.ContentBlockParam[] = open.map((b) => ({
        type: "tool_result",
        tool_use_id: b.id,
        is_error: true,
        content: "Not run: the request was cut off.",
      }));
      content.push({ type: "text", text });
      state.messages.push({ role: "user", content });
    },

    async step(state, io) {
      const tools: Anthropic.Tool[] = toolList(io.tools).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
        eager_input_streaming: true,
      }));
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      for (let resumes = 0, badJson = 0; ; ) {
        let msg: Anthropic.Message;
        try {
          msg = await client.messages
            .stream(
              {
                model: opts.model,
                max_tokens: MAX_TOKENS,
                thinking: { type: "adaptive" },
                system: io.systemPrompt,
                ...(tools.length ? { tools } : {}),
                messages: state.messages,
              },
              { signal: io.signal },
            )
            .finalMessage();
        } catch (err) {
          if (err instanceof Anthropic.APIError || io.signal.aborted || badJson++ >= MAX_BAD_JSON) throw explain(err);
          continue;
        }
        state.messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
        inputTokens += msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0);
        outputTokens += msg.usage.output_tokens;
        for (const block of msg.content) if (block.type === "text") text += (text ? "\n\n" : "") + block.text;
        if (msg.stop_reason === "pause_turn" && resumes++ < MAX_RESUMES) continue;

        const calls: ToolCall[] = msg.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : []));
        const stop =
          msg.stop_reason === "refusal"
            ? "refusal"
            : msg.stop_reason === "max_tokens" || msg.stop_reason === "model_context_window_exceeded"
              ? "length"
              : calls.length
                ? "tool_use"
                : "end";
        return { text, calls, stop, usage: { inputTokens, outputTokens } };
      }
    },

    addResults(state, results) {
      state.messages.push({
        role: "user",
        content: results.map((r) => ({ type: "tool_result", tool_use_id: r.call.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })),
      });
    },
  };
}

function explain(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new EngineError("auth", "Your Anthropic API key was rejected.");
  if (err instanceof Anthropic.PermissionDeniedError) return new EngineError("auth", "This Anthropic API key can't use this model. Check your organization's access.");
  if (err instanceof Anthropic.RateLimitError) return new Error("Rate limited by Anthropic. Try again shortly.");
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return new EngineError("limit", "Your Anthropic account is out of credit.");
    return new EngineError("bad_request", `Anthropic rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) return new Error("Couldn't reach Anthropic.");
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic returned an error (${err.status ?? "unknown"}).`);
  return err instanceof Error ? err : new Error(String(err));
}
