import { EngineError, toolList, type ModelAdapter, type ToolCall } from "../loop.ts";

/**
 * OpenAI-compatible Chat Completions (Gemini's compatibility endpoint, OpenRouter), without streaming.
 * The assistant message is stored exactly as the provider sent it, so extras survive the round trip:
 * Gemini's thought signatures (tool_calls[].extra_content.google.thought_signature) are required back
 * on the next request, and OpenRouter's reasoning details help the model keep its thread.
 */

type Message = { role: string; content?: unknown; tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[]; [key: string]: unknown };

export interface ChatState {
  messages: Message[];
}

export interface ChatOptions {
  /** For messages people read: "Gemini", "OpenRouter". */
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function chatCompletionsAdapter(opts: ChatOptions): ModelAdapter<ChatState> {
  return {
    init: () => ({ messages: [] }),

    addUser(state, text) {
      // A turn that ended mid-call leaves tool calls unanswered, which providers reject.
      const answered = new Set(state.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
      for (const m of state.messages) {
        for (const c of m.role === "assistant" ? (m.tool_calls ?? []) : []) {
          if (!answered.has(c.id)) state.messages.push({ role: "tool", tool_call_id: c.id, content: "Not run: the request was cut off." });
        }
      }
      state.messages.push({ role: "user", content: text });
    },

    async step(state, io) {
      const tools = toolList(io.tools).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: "system", content: io.systemPrompt }, ...state.messages],
          ...(tools.length ? { tools } : {}),
        }),
        signal: io.signal,
      });
      const body = (await res.json().catch(() => null)) as any;
      // Gemini wraps errors in an array; OpenRouter can also report one with a 200.
      const error = (Array.isArray(body) ? body[0] : body)?.error;
      if (!res.ok || error) throw failure(opts.provider, res.status, error?.message);
      const choice = body?.choices?.[0];
      if (!choice?.message) throw new Error(`${opts.provider} sent back an empty answer.`);

      const message = choice.message as Message;
      // Some providers leave tool call ids empty; the answers need something to point at.
      for (const [i, c] of (message.tool_calls ?? []).entries()) c.id ||= `call_${state.messages.length}_${i}`;
      state.messages.push(message);

      const calls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({ id: c.id!, name: c.function?.name ?? "", input: parseArguments(c.function?.arguments) }));
      const stop = choice.finish_reason === "length" ? "length" : choice.finish_reason === "content_filter" ? "refusal" : calls.length ? "tool_use" : "end";
      const cost = typeof body.usage?.cost === "number" ? body.usage.cost * 100 : undefined;
      return {
        text: typeof message.content === "string" ? message.content : "",
        calls,
        stop,
        usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, ...(cost ? { costCents: cost } : {}) },
      };
    },

    addResults(state, results) {
      for (const r of results) state.messages.push({ role: "tool", tool_call_id: r.call.id, content: r.text });
    },
  };
}

/** Bad JSON goes back as a string, so the command registry's validation answers the model with an error it can fix. */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function failure(provider: string, status: number, message: string | undefined): Error {
  if (status === 401 || status === 403) return new EngineError("auth", `Your ${provider} API key was rejected.`);
  if (status === 402) return new EngineError("limit", `Your ${provider} account is out of credit.`);
  if (status === 429) return new Error(`Rate limited by ${provider}. Try again shortly.`);
  if (status === 400) return new EngineError("bad_request", `${provider} rejected the request: ${message ?? "bad request"}`);
  return new Error(message ? `${provider} reported an error: ${message}` : `${provider} returned an error (${status}).`);
}
