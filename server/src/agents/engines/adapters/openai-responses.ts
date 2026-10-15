import { EngineError, readSse, toolList, type ModelAdapter, type StepResult, type ToolCall } from "../loop.ts";

/**
 * OpenAI's Responses API over plain fetch. Serves API keys and, with `chatgpt: true`, "Sign in with
 * ChatGPT" (plan usage), which takes the same requests minus the parameters its preview doesn't accept.
 * Nothing is stored on OpenAI's side (store: false), so every step replays the model's own output items.
 */

type Item = { type?: string; [key: string]: unknown };

export interface ResponsesState {
  items: Item[];
}

export interface ResponsesOptions {
  baseUrl: string;
  /** Called before every request, so a refreshed sign-in token is picked up. */
  token: () => Promise<string>;
  model: string;
  chatgpt: boolean;
}

const MAX_OUTPUT_TOKENS = 16_000;

const LIMIT_MESSAGE =
  "You've reached your ChatGPT usage limit for Slipstream. It resets on your plan's schedule, or raise Slipstream's share in ChatGPT Settings → Usage.";
const UNAVAILABLE_MESSAGE = "ChatGPT plan usage isn't available for this account right now. Check that plan use is turned on for Slipstream in ChatGPT Settings, then try again.";

export function responsesAdapter(opts: ResponsesOptions): ModelAdapter<ResponsesState> {
  return {
    init: () => ({ items: [] }),

    addUser(state, text) {
      // A turn that ended mid-call (a refusal) leaves calls unanswered; the API rejects the next request unless they are.
      const answered = new Set(state.items.filter((i) => i.type === "function_call_output").map((i) => i.call_id));
      for (const item of state.items) {
        if (item.type === "function_call" && !answered.has(item.call_id)) {
          state.items.push({ type: "function_call_output", call_id: item.call_id, output: "Not run: the request was cut off." });
        }
      }
      state.items.push({ role: "user", content: text });
    },

    async step(state, io) {
      const tools = toolList(io.tools).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
      const body = {
        model: opts.model,
        instructions: io.systemPrompt,
        input: state.items,
        ...(tools.length ? { tools } : {}),
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
        // The ChatGPT preview rejects max_output_tokens (and temperature, previous_response_id, …).
        ...(opts.chatgpt ? {} : { max_output_tokens: MAX_OUTPUT_TOKENS }),
      };
      const res = await fetch(`${opts.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${await opts.token()}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: io.signal,
      });
      if (!res.ok || !res.body) {
        const err = await readError(res);
        throw failure(res.status, err.code, err.message, opts.chatgpt);
      }

      const output: Item[] = [];
      let done: { output?: Item[]; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
      let incomplete: string | null = null;
      for await (const ev of readSse(res.body, io.signal)) {
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (data.type === "response.output_item.done" && data.item) output.push(data.item);
        else if (data.type === "response.completed") done = data.response ?? {};
        else if (data.type === "response.incomplete") {
          done = data.response ?? {};
          incomplete = data.response?.incomplete_details?.reason ?? "unknown";
        } else if (data.type === "response.failed") {
          const e = data.response?.error;
          throw failure(null, e?.code, e?.message, opts.chatgpt);
        } else if (data.type === "error") throw failure(null, data.code, data.message, opts.chatgpt);
      }
      if (!done) throw new Error("OpenAI ended the response early. Try again.");

      const items = output.length ? output : (done.output ?? []);
      state.items.push(...items);
      let text = "";
      let refused = false;
      const calls: ToolCall[] = [];
      for (const item of items) {
        if (item.type === "function_call") {
          calls.push({ id: String(item.call_id), name: String(item.name), input: parseArguments(item.arguments) });
        } else if (item.type === "message") {
          for (const part of (item.content as { type?: string; text?: string; refusal?: string }[] | undefined) ?? []) {
            if (part.type === "output_text") text += part.text ?? "";
            else if (part.type === "refusal") {
              refused = true;
              text += part.refusal ?? "";
            }
          }
        }
      }
      const stop: StepResult["stop"] =
        incomplete === "max_output_tokens" ? "length" : incomplete === "content_filter" || (refused && !calls.length) ? "refusal" : calls.length ? "tool_use" : "end";
      return { text, calls, stop, usage: { inputTokens: done.usage?.input_tokens ?? 0, outputTokens: done.usage?.output_tokens ?? 0 } };
    },

    addResults(state, results) {
      for (const r of results) state.items.push({ type: "function_call_output", call_id: r.call.id, output: r.text });
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

async function readError(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return { code: body.error?.code ?? undefined, message: body.error?.message };
  } catch {
    return {};
  }
}

function failure(status: number | null, code: string | undefined, message: string | undefined, chatgpt: boolean): Error {
  if (code?.startsWith("subscription_sharing_usage_limit")) return new EngineError("limit", LIMIT_MESSAGE);
  if (code?.startsWith("subscription_sharing_")) return new EngineError("unavailable", UNAVAILABLE_MESSAGE);
  if (status === 401) {
    return new EngineError("auth", chatgpt ? "Your ChatGPT sign-in has expired. Sign in again to keep going." : "Your OpenAI API key was rejected.");
  }
  if (code === "insufficient_quota") return new EngineError("limit", "Your OpenAI account is out of credit.");
  if (status === 429 || code === "rate_limit_exceeded") return new Error("Rate limited by OpenAI. Try again shortly.");
  if (status === 400) return new EngineError("bad_request", `OpenAI rejected the request: ${message ?? "bad request"}`);
  if (status) return new Error(`OpenAI returned an error (${status}).`);
  return new Error(message || "OpenAI reported an error.");
}
