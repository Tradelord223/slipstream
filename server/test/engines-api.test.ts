import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { EngineAccounts } from "../src/agents/engines/accounts.ts";
import { responsesAdapter } from "../src/agents/engines/adapters/openai-responses.ts";
import { apiEngines } from "../src/agents/engines/api.ts";
import { runLoop } from "../src/agents/engines/loop.ts";
import type { Engine, EngineId } from "../src/agents/engines/types.ts";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { fakeIO, type FakeIO } from "./engine-io.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * The API-key engines against stand-ins for each provider's wire format: the model searches mail,
 * drafts a reply, asks to send it (which waits for approval), then answers.
 */

type Kind = "openai" | "anthropic" | "gemini" | "openrouter";
const ENGINE: Record<Kind, EngineId> = { openai: "loop:openai", anthropic: "loop:anthropic", gemini: "loop:gemini", openrouter: "loop:openrouter" };
const BASE_ENV: Record<Kind, string> = {
  openai: "SLIPSTREAM_OPENAI_BASE_URL",
  anthropic: "SLIPSTREAM_ANTHROPIC_BASE_URL",
  gemini: "SLIPSTREAM_GEMINI_BASE_URL",
  openrouter: "SLIPSTREAM_OPENROUTER_BASE_URL",
};
const PREFIX: Record<Kind, string> = { openai: "/v1", anthropic: "", gemini: "/v1beta/openai", openrouter: "/api/v1" };
const CHAT_PATH: Record<Kind, string> = {
  openai: "/v1/responses",
  anthropic: "/v1/messages",
  gemini: "/v1beta/openai/chat/completions",
  openrouter: "/api/v1/chat/completions",
};
const MODELS_PATH: Record<Kind, string> = {
  openai: "/v1/models",
  anthropic: "/v1/models",
  gemini: "/v1beta/openai/models",
  openrouter: "/api/v1/models",
};
const KINDS = Object.keys(ENGINE) as Kind[];

interface Call {
  id: string;
  name: string;
  input: unknown;
}
interface Step {
  text?: string;
  calls?: Call[];
  stop?: "length" | "refusal" | "pause";
  /** Answer with an HTTP error instead. */
  fail?: { status: number; body: unknown; headers?: Record<string, string> };
  /** Answer with a stream that reports an error (Responses only). */
  streamError?: { type: "response.failed" | "error"; code: string; message: string };
}
type Script = Step[] | ((n: number) => Step);

const APPROVAL = "Waiting for the user's approval (sending). It's in their Review queue; it runs when they approve. Don't retry.";
const FINAL = "I drafted a reply to Marcus Bell. It's in your Review queue for approval.";
const SCRIPT: Step[] = [
  { calls: [{ id: "call_1", name: "mail_search", input: { query: "from:marcus", limit: 5 } }] },
  { calls: [{ id: "call_2", name: "drafts_create", input: { threadId: "thr_1", body: "Thanks Marcus, Friday works." } }] },
  { calls: [{ id: "call_3", name: "drafts_send", input: { draftId: "drf_1" } }] },
  { text: FINAL },
  { text: "Anything else for Marcus?" },
];

function answers() {
  return {
    mail_search: () => JSON.stringify({ threads: [{ id: "thr_1", subject: "Friday sync" }] }),
    drafts_create: () => JSON.stringify({ draftId: "drf_1" }),
    drafts_send: () => APPROVAL,
  };
}

const OPENAI_MODELS = [
  { id: "gpt-6-luna", created: 100 },
  { id: "gpt-6.1-sol", created: 300 },
  { id: "gpt-6-astra", created: 200 },
  { id: "o5-mini", created: 50 },
  { id: "gpt-6-realtime", created: 400 },
  { id: "gpt-image-2", created: 400 },
  { id: "gpt-4o-mini-tts", created: 10 },
  { id: "gpt-4o-transcribe", created: 10 },
  { id: "gpt-5-search-api", created: 10 },
  { id: "gpt-4o-audio-preview", created: 10 },
  { id: "text-embedding-3-large", created: 400 },
  { id: "whisper-1", created: 400 },
];
const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", adaptive: true },
  { id: "claude-sonnet-5-5", adaptive: true },
  { id: "claude-haiku-4-5", adaptive: false },
];
const GEMINI_MODELS = ["models/gemini-4-argon", "models/gemini-3.8-flash", "models/gemini-3.8-live", "models/gemini-nano-banana-2.1", "models/text-embedding-004"];
const OPENROUTER_MODELS = ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5:batch", "openai/gpt-6.1-sol", "meta/muse-spark-open:free"];

interface Hit {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

/** A local stand-in for one provider's API. */
class Stand {
  kind: Kind;
  script: Script;
  hits: Hit[] = [];
  /** Bodies of the model requests, in order. */
  chats: any[] = [];
  modelsStatus = 200;
  server = createServer((req, res) => void this.handle(req, res));
  url = "";

  constructor(kind: Kind, script: Script) {
    this.kind = kind;
    this.script = script;
  }

  get base() {
    return `${this.url}${PREFIX[this.kind]}`;
  }

  get modelHits() {
    return this.hits.filter((h) => h.method === "GET" && h.path.endsWith("/models"));
  }

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  private async handle(req: import("node:http").IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url!, "http://x").pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    this.hits.push({ method: req.method!, path, headers: req.headers, body });
    const json = (status: number, o: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(o));
    };
    if (req.method === "GET" && path === MODELS_PATH[this.kind]) {
      if (this.modelsStatus !== 200) return json(this.modelsStatus, { error: { message: "nope" } });
      return json(200, this.modelList());
    }
    if (req.method !== "POST" || path !== CHAT_PATH[this.kind]) return json(404, { error: { message: `no route ${path}` } });

    const n = this.chats.length;
    this.chats.push(body);
    const step = typeof this.script === "function" ? this.script(n) : (this.script[n] ?? { text: "(the script ran out)" });
    if (!answersEveryCall(this.kind, body)) return json(400, { type: "error", error: { type: "invalid_request_error", message: "a tool call has no answer", code: "invalid_prompt" } });
    if (step.fail) return json(step.fail.status, step.fail.body, step.fail.headers);
    if (this.kind === "openai") return this.responses(res, step, n);
    if (this.kind === "anthropic") return this.messages(res, step, n);
    return json(200, this.completion(step, n));
  }

  private modelList() {
    if (this.kind === "openai") return { object: "list", data: OPENAI_MODELS.map((m) => ({ ...m, object: "model" })) };
    if (this.kind === "anthropic") {
      const data = ANTHROPIC_MODELS.map((m) => ({
        id: m.id,
        type: "model",
        display_name: m.id,
        created_at: "2026-09-01T00:00:00Z",
        capabilities: { thinking: { supported: true, types: { adaptive: { supported: m.adaptive }, enabled: { supported: !m.adaptive }, disabled: { supported: true } } } },
      }));
      return { data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id };
    }
    if (this.kind === "gemini") return { object: "list", data: GEMINI_MODELS.map((id) => ({ id, object: "model" })) };
    return { data: OPENROUTER_MODELS.map((id) => ({ id })) };
  }

  private responses(res: ServerResponse, step: Step, n: number) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    const response = { id: `resp_${n}`, status: "completed", usage: { input_tokens: 100 * (n + 1), output_tokens: 20 } };
    send("response.created", { response: { id: response.id } });
    if (step.streamError) {
      if (step.streamError.type === "error") send("error", { code: step.streamError.code, message: step.streamError.message });
      else send("response.failed", { response: { ...response, status: "failed", error: { code: step.streamError.code, message: step.streamError.message } } });
      return res.end();
    }
    if (step.calls) send("response.output_item.done", { item: { type: "reasoning", id: `rs_${n}`, summary: [], encrypted_content: `enc_${n}` } });
    for (const c of step.calls ?? []) {
      send("response.output_item.done", { item: { type: "function_call", id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.input), status: "completed" } });
    }
    if (step.text) {
      send("response.output_text.delta", { delta: step.text });
      send("response.output_item.done", { item: { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] } });
    }
    if (step.stop === "length") send("response.incomplete", { response: { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
    else if (step.stop === "refusal") send("response.incomplete", { response: { ...response, status: "incomplete", incomplete_details: { reason: "content_filter" } } });
    else send("response.completed", { response });
    res.end();
  }

  private messages(res: ServerResponse, step: Step, n: number) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    send("message_start", {
      message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100 * (n + 1), output_tokens: 1 } },
    });
    let i = 0;
    const block = (start: object, deltas: object[]) => {
      send("content_block_start", { index: i, content_block: start });
      for (const delta of deltas) send("content_block_delta", { index: i, delta });
      send("content_block_stop", { index: i });
      i += 1;
    };
    if (step.calls) {
      block({ type: "thinking", thinking: "", signature: "" }, [
        { type: "thinking_delta", thinking: "The user wants a reply drafted." },
        { type: "signature_delta", signature: `sig_${n}` },
      ]);
    }
    if (step.text) block({ type: "text", text: "" }, [{ type: "text_delta", text: step.text }]);
    for (const c of step.calls ?? []) {
      const json = JSON.stringify(c.input);
      const cut = Math.floor(json.length / 2);
      block({ type: "tool_use", id: c.id, name: c.name, input: {} }, [
        { type: "input_json_delta", partial_json: json.slice(0, cut) },
        { type: "input_json_delta", partial_json: json.slice(cut) },
      ]);
    }
    const stop_reason = step.stop === "refusal" ? "refusal" : step.stop === "length" ? "max_tokens" : step.stop === "pause" ? "pause_turn" : step.calls ? "tool_use" : "end_turn";
    send("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
    send("message_stop", {});
    res.end();
  }

  private completion(step: Step, n: number) {
    const gemini = this.kind === "gemini";
    const tool_calls = step.calls?.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.input) },
      ...(gemini ? { extra_content: { google: { thought_signature: `sig_${c.id}` } } } : {}),
    }));
    return {
      id: `chatcmpl_${n}`,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: step.stop === "length" ? "length" : step.stop === "refusal" ? "content_filter" : tool_calls ? "tool_calls" : "stop",
          message: { role: "assistant", content: step.text ?? null, ...(tool_calls ? { tool_calls } : {}), ...(this.kind === "openrouter" && tool_calls ? { reasoning: "Draft first, then ask to send." } : {}) },
        },
      ],
      usage: { prompt_tokens: 100 * (n + 1), completion_tokens: 20, ...(this.kind === "openrouter" ? { cost: 0.0123 } : {}) },
    };
  }
}

/** The providers reject a request that leaves a tool call unanswered; so does the stand-in. */
function answersEveryCall(kind: Kind, body: any): boolean {
  let asked: string[] = [];
  let answered: string[] = [];
  if (kind === "openai") {
    asked = body.input.filter((i: any) => i.type === "function_call").map((i: any) => i.call_id);
    answered = body.input.filter((i: any) => i.type === "function_call_output").map((i: any) => i.call_id);
  } else if (kind === "anthropic") {
    const blocks = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    asked = blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
    answered = blocks.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id);
  } else {
    asked = body.messages.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.id));
    answered = body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
  }
  return asked.length === answered.length && asked.every((id) => answered.includes(id));
}

async function withStand<T>(kind: Kind, script: Script, fn: (s: Stand) => Promise<T>): Promise<T> {
  const stand = new Stand(kind, script);
  await stand.listen();
  const prev = process.env[BASE_ENV[kind]];
  process.env[BASE_ENV[kind]] = stand.base;
  try {
    return await fn(stand);
  } finally {
    if (prev === undefined) delete process.env[BASE_ENV[kind]];
    else process.env[BASE_ENV[kind]] = prev;
    await stand.close();
  }
}

const KEYS = { openaiApiKey: "sk-env-openai", anthropicApiKey: "sk-ant-env", geminiApiKey: "gm-env", openrouterApiKey: "sk-or-env" };
const NO_KEYS = { openaiApiKey: undefined, anthropicApiKey: undefined, geminiApiKey: undefined, openrouterApiKey: undefined };

let env: TestEnv;
let accounts: EngineAccounts;
const engineFor = (kind: Kind): Engine => apiEngines(env.ctx, accounts).find((e) => e.id === ENGINE[kind])!;

before(() => {
  env = makeEnv(KEYS);
  accounts = new EngineAccounts(env.ctx);
});
after(() => env.cleanup());

const toolsOf = (body: any): any[] => body.tools ?? [];

for (const kind of KINDS) {
  describe(`${ENGINE[kind]}: a full turn`, () => {
    let stand: Stand;
    let io: FakeIO;
    let outcome: unknown;
    let io2: FakeIO;
    let outcome2: unknown;

    before(async () => {
      stand = new Stand(kind, SCRIPT);
      await stand.listen();
      process.env[BASE_ENV[kind]] = stand.base;
      const engine = engineFor(kind);
      io = fakeIO({ answers: answers() });
      outcome = await engine.turn(io, "Reply to Marcus about Friday.");
      // A follow-up resumes from the saved conversation.
      io2 = fakeIO({ answers: answers(), state: io.state });
      outcome2 = await engine.turn(io2, "Anything else?");
    });
    after(async () => {
      delete process.env[BASE_ENV[kind]];
      await stand.close();
    });

    test("runs the model's tool calls through the command registry and answers", () => {
      assert.deepEqual(outcome, { outcome: "done" });
      assert.deepEqual(
        io.calls.map((c) => c.name),
        ["mail_search", "drafts_create", "drafts_send"],
      );
      assert.deepEqual(io.calls[0].input, { query: "from:marcus", limit: 5 });
      assert.deepEqual(io.said, [FINAL]);
      assert.equal(stand.chats.length, 5);
    });

    test("sends tools without $schema, and the system prompt", () => {
      for (const body of stand.chats) assert.ok(!JSON.stringify(toolsOf(body)).includes("$schema"));
      const names = toolsOf(stand.chats[0]).map((t) => t.name ?? t.function?.name);
      assert.deepEqual(names, ["mail_search", "drafts_create", "drafts_send"]);
      const sys = kind === "openai" ? stand.chats[0].instructions : kind === "anthropic" ? stand.chats[0].system : stand.chats[0].messages[0].content;
      assert.equal(sys, "You are a test assistant.");
    });

    test("uses the saved key and the provider's default model", () => {
      const model = { openai: "gpt-6.1-sol", anthropic: "claude-opus-5-5", gemini: "gemini-3.8-flash", openrouter: "anthropic/claude-opus-5.5" }[kind];
      assert.equal(stand.chats[0].model, model);
      const post = stand.hits.find((h) => h.method === "POST")!;
      const key = { openai: "sk-env-openai", anthropic: "sk-ant-env", gemini: "gm-env", openrouter: "sk-or-env" }[kind];
      assert.equal(kind === "anthropic" ? post.headers["x-api-key"] : post.headers.authorization, kind === "anthropic" ? key : `Bearer ${key}`);
    });

    test("gives the model every earlier step on the next one", () => {
      const last = stand.chats[3];
      if (kind === "openai") {
        const types = last.input.map((i: any) => i.type ?? i.role);
        assert.deepEqual(types, ["user", "reasoning", "function_call", "function_call_output", "reasoning", "function_call", "function_call_output", "reasoning", "function_call", "function_call_output"]);
        assert.equal(last.input[1].encrypted_content, "enc_0");
        assert.equal(last.input[2].call_id, "call_1");
        assert.equal(last.input.at(-1).output, APPROVAL);
      } else if (kind === "anthropic") {
        assert.deepEqual(
          last.messages.map((m: any) => m.role),
          ["user", "assistant", "user", "assistant", "user", "assistant", "user"],
        );
        assert.equal(last.messages.at(-1).content[0].content, APPROVAL);
      } else {
        assert.deepEqual(
          last.messages.map((m: any) => m.role),
          ["system", "user", "assistant", "tool", "assistant", "tool", "assistant", "tool"],
        );
        assert.equal(last.messages.at(-1).content, APPROVAL);
      }
    });

    test("a follow-up continues the same conversation", () => {
      assert.deepEqual(outcome2, { outcome: "done" });
      assert.deepEqual(io2.said, ["Anything else for Marcus?"]);
      const req = stand.chats[4];
      const text = JSON.stringify(req);
      assert.ok(text.includes("Reply to Marcus about Friday.") && text.includes(FINAL) && text.includes("Anything else?"));
      const list = req.input ?? req.messages;
      assert.equal(JSON.stringify(list.at(-1)).includes("Anything else?"), true);
    });
  });
}

describe("OpenAI Responses requests", () => {
  test("API mode: store false, streamed, instructions, replayed reasoning and a token cap", async () => {
    await withStand("openai", SCRIPT, async (s) => {
      await engineFor("openai").turn(fakeIO({ answers: answers() }), "Reply to Marcus about Friday.");
      const [first, second] = s.chats;
      assert.equal(first.store, false);
      assert.equal(first.stream, true);
      assert.equal(first.max_output_tokens, 16000);
      assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
      assert.equal(first.instructions, "You are a test assistant.");
      assert.deepEqual(first.input, [{ role: "user", content: "Reply to Marcus about Friday." }]);
      assert.equal(first.tools[0].type, "function");
      assert.equal(first.tools[0].strict, false);
      assert.equal(first.tools[0].name, "mail_search");
      assert.deepEqual(first.tools[0].parameters.required, ["query"]);
      assert.equal(second.input[1].type, "reasoning");
      assert.equal(second.input[2].arguments, JSON.stringify({ query: "from:marcus", limit: 5 }));
      assert.ok(!second.input.some((i: any) => i.role === "system" || i.role === "developer"));
    });
  });

  test("ChatGPT mode: the preview's parameters are left out and the sign-in token is used", async () => {
    await withStand("openai", SCRIPT, async (s) => {
      let refreshes = 0;
      const adapter = responsesAdapter({ baseUrl: s.base, token: async () => `chatgpt-token-${++refreshes}`, model: "gpt-6.1-sol", chatgpt: true });
      const io = fakeIO({ answers: answers() });
      const outcome = await runLoop(io, adapter, "Reply to Marcus about Friday.");
      assert.deepEqual(outcome, { outcome: "done" });
      for (const body of s.chats) {
        for (const key of ["max_output_tokens", "temperature", "previous_response_id", "background", "conversation", "metadata", "top_p", "truncation", "user", "max_tool_calls"]) {
          assert.ok(!(key in body), `${key} must not be sent`);
        }
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.equal(body.instructions, "You are a test assistant.");
        assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      }
      assert.deepEqual(
        s.hits.filter((h) => h.method === "POST").map((h) => h.headers.authorization),
        ["Bearer chatgpt-token-1", "Bearer chatgpt-token-2", "Bearer chatgpt-token-3", "Bearer chatgpt-token-4"],
      );
    });
  });
});

describe("Claude API requests", () => {
  test("thinking is adaptive, streamed, and the thinking blocks are replayed with their signatures", async () => {
    await withStand("anthropic", SCRIPT, async (s) => {
      await engineFor("anthropic").turn(fakeIO({ answers: answers() }), "Reply to Marcus about Friday.");
      const [first, second, third] = s.chats;
      assert.equal(first.stream, true);
      assert.equal(first.max_tokens, 16000);
      assert.deepEqual(first.thinking, { type: "adaptive" });
      assert.equal(first.tools[0].eager_input_streaming, true);
      assert.deepEqual(Object.keys(first.tools[0]).sort(), ["description", "eager_input_streaming", "input_schema", "name"]);
      const assistant = second.messages[1];
      assert.equal(assistant.role, "assistant");
      assert.equal(assistant.content[0].type, "thinking");
      assert.equal(assistant.content[0].thinking, "The user wants a reply drafted.");
      assert.equal(assistant.content[0].signature, "sig_0");
      assert.deepEqual(assistant.content[1], { type: "tool_use", id: "call_1", name: "mail_search", input: { query: "from:marcus", limit: 5 } });
      assert.deepEqual(second.messages[2].content, [{ type: "tool_result", tool_use_id: "call_1", content: JSON.stringify({ threads: [{ id: "thr_1", subject: "Friday sync" }] }) }]);
      assert.equal(third.messages[3].content[0].signature, "sig_1");
    });
  });

  test("a paused turn is sent back to continue, and what it said is kept", async () => {
    await withStand("anthropic", [{ text: "Looking through your inbox.", stop: "pause" }, { text: "Nothing urgent today." }], async (s) => {
      const io = fakeIO({ answers: answers() });
      assert.deepEqual(await engineFor("anthropic").turn(io, "Anything urgent?"), { outcome: "done" });
      assert.equal(s.chats.length, 2);
      assert.equal(s.chats[1].messages.at(-1).role, "assistant");
      assert.deepEqual(io.said, ["Looking through your inbox.\n\nNothing urgent today."]);
    });
  });
});

describe("Gemini requests", () => {
  test("thought signatures and provider extras are replayed as received", async () => {
    await withStand("gemini", SCRIPT, async (s) => {
      await engineFor("gemini").turn(fakeIO({ answers: answers() }), "Reply to Marcus about Friday.");
      const [first, second] = s.chats;
      assert.deepEqual(first.messages[0], { role: "system", content: "You are a test assistant." });
      assert.equal(first.tools[0].type, "function");
      assert.deepEqual(Object.keys(first.tools[0].function).sort(), ["description", "name", "parameters"]);
      const assistant = second.messages[2];
      assert.equal(assistant.tool_calls[0].extra_content.google.thought_signature, "sig_call_1");
      assert.deepEqual(second.messages[3], { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ threads: [{ id: "thr_1", subject: "Friday sync" }] }) });
    });
  });
});

describe("OpenRouter", () => {
  test("reports the cost from the response in cents, and replays reasoning", async () => {
    await withStand("openrouter", SCRIPT, async (s) => {
      const io = fakeIO({ answers: answers() });
      await engineFor("openrouter").turn(io, "Reply to Marcus about Friday.");
      // Four model calls at $0.0123 each.
      assert.ok(Math.abs(io.cents - 4 * 1.23) < 1e-9, `got ${io.cents}`);
      assert.equal(s.chats[1].messages[2].reasoning, "Draft first, then ask to send.");
      assert.ok(!("usage" in s.chats[0]), "no usage option is needed");
    });
  });
});

describe("failures", () => {
  type Case = { name: string; kind: Kind; step: Step; outcome: "failed" | "limit"; error: RegExp };
  const cases: Case[] = [
    { name: "OpenAI 401", kind: "openai", step: { fail: { status: 401, body: { error: { message: "bad key", code: "invalid_api_key" } } } }, outcome: "failed", error: /^Your OpenAI API key was rejected\.$/ },
    { name: "OpenAI out of credit", kind: "openai", step: { fail: { status: 429, body: { error: { message: "You exceeded your current quota", code: "insufficient_quota" } } } }, outcome: "limit", error: /out of credit/ },
    { name: "OpenAI rate limit", kind: "openai", step: { fail: { status: 429, body: { error: { message: "slow down", code: "rate_limit_exceeded" } } } }, outcome: "failed", error: /^Rate limited by OpenAI\. Try again shortly\.$/ },
    { name: "OpenAI stream error", kind: "openai", step: { streamError: { type: "error", code: "server_error", message: "The server had an error" } }, outcome: "failed", error: /The server had an error/ },
    { name: "Claude 401", kind: "anthropic", step: { fail: { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } } }, outcome: "failed", error: /^Your Anthropic API key was rejected\.$/ },
    {
      name: "Claude out of credit",
      kind: "anthropic",
      step: { fail: { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } } },
      outcome: "limit",
      error: /out of credit/,
    },
    {
      name: "Claude rate limit",
      kind: "anthropic",
      step: { fail: { status: 429, headers: { "retry-after-ms": "1" }, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } } },
      outcome: "failed",
      error: /^Rate limited by Anthropic\. Try again shortly\.$/,
    },
    { name: "Gemini 401", kind: "gemini", step: { fail: { status: 401, body: [{ error: { code: 401, message: "API key not valid" } }] } }, outcome: "failed", error: /^Your Gemini API key was rejected\.$/ },
    { name: "Gemini rate limit", kind: "gemini", step: { fail: { status: 429, body: [{ error: { code: 429, message: "Resource exhausted" } }] } }, outcome: "failed", error: /^Rate limited by Gemini/ },
    { name: "OpenRouter out of credit", kind: "openrouter", step: { fail: { status: 402, body: { error: { code: 402, message: "Insufficient credits" } } } }, outcome: "limit", error: /out of credit/ },
    { name: "OpenRouter error in a 200", kind: "openrouter", step: { fail: { status: 200, body: { error: { code: 502, message: "Upstream timed out" } } } }, outcome: "failed", error: /Upstream timed out/ },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      // The SDK retries a rate limit, so the failure repeats for every attempt.
      await withStand(c.kind, () => c.step, async () => {
        const out = await engineFor(c.kind).turn(fakeIO({ answers: answers() }), "Hello");
        assert.equal(out.outcome, c.outcome);
        assert.match((out as { error: string }).error, c.error);
      });
    });
  }

  test("ChatGPT usage limit says where to raise it", async () => {
    const step: Step = { streamError: { type: "response.failed", code: "subscription_sharing_usage_limit_exceeded", message: "limit" } };
    await withStand("openai", [step], async (s) => {
      const adapter = responsesAdapter({ baseUrl: s.base, token: async () => "t", model: "gpt-6.1-sol", chatgpt: true });
      const out = await runLoop(fakeIO({}), adapter, "Hello");
      assert.equal(out.outcome, "limit");
      assert.match((out as { error: string }).error, /^You've reached your ChatGPT usage limit for Slipstream\..*ChatGPT Settings → Usage\.$/);
    });
  });

  test("ChatGPT plan use being unavailable, and an expired sign-in", async () => {
    const unavailable: Step = { streamError: { type: "response.failed", code: "subscription_sharing_usage_unavailable", message: "unavailable" } };
    const expired: Step = { fail: { status: 401, body: { error: { message: "token expired", code: "invalid_token" } } } };
    await withStand("openai", [unavailable, expired], async (s) => {
      const adapter = responsesAdapter({ baseUrl: s.base, token: async () => "t", model: "gpt-6.1-sol", chatgpt: true });
      const a = await runLoop(fakeIO({}), adapter, "Hello");
      assert.equal(a.outcome, "failed");
      assert.match((a as { error: string }).error, /plan usage isn't available/);
      const b = await runLoop(fakeIO({}), adapter, "Hello");
      assert.match((b as { error: string }).error, /sign-in has expired/);
    });
  });

  test("a stream that stops before it completes is a failure, not a silent finish", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r" } })}\n\n`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const out = await runLoop(fakeIO({}), responsesAdapter({ baseUrl: url, token: async () => "t", model: "m", chatgpt: false }), "Hello");
      assert.equal(out.outcome, "failed");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("turns that stop early still leave a valid conversation", () => {
  const cut: Call = { id: "call_9", name: "mail_search", input: { query: "from:marcus" } };
  for (const kind of KINDS) {
    test(`${ENGINE[kind]}: the 25-call cap is answered cleanly`, async () => {
      const script = (n: number): Step => (n <= 25 ? { calls: [{ id: `call_${n}`, name: "mail_search", input: { query: "x" } }] } : { text: "Picking up." });
      await withStand(kind, script, async (s) => {
        const engine = engineFor(kind);
        const io = fakeIO({ answers: answers() });
        const out = await engine.turn(io, "Go through everything.");
        assert.deepEqual(out, { outcome: "done" }, "a pause, not a failure");
        assert.match(io.notes.join(" "), /25 tool calls/);
        assert.equal(io.calls.length, 25);
        const io2 = fakeIO({ answers: answers(), state: io.state });
        assert.deepEqual(await engine.turn(io2, "Carry on."), { outcome: "done" });
        assert.deepEqual(io2.said, ["Picking up."]);
        assert.equal(s.chats.length, 27);
      });
    });

    for (const stop of ["refusal", "length"] as const) {
      test(`${ENGINE[kind]}: ${stop} with a call in flight does not run it, and a follow-up works`, async () => {
        await withStand(kind, [{ calls: [cut], stop }, { text: "Back on track." }], async () => {
          const engine = engineFor(kind);
          const io = fakeIO({ answers: answers() });
          const out = await engine.turn(io, "Search.");
          assert.equal(out.outcome, "failed");
          assert.match((out as { error: string }).error, stop === "refusal" ? /declined/ : /ran out of room/);
          assert.equal(io.calls.length, 0);
          const io2 = fakeIO({ answers: answers(), state: io.state });
          assert.deepEqual(await engine.turn(io2, "Try again."), { outcome: "done" });
          assert.deepEqual(io2.said, ["Back on track."]);
        });
      });
    }
  }
});

describe("models and status", () => {
  test("OpenAI lists chat models newest first and picks the flagship", async () => {
    await withStand("openai", [], async (s) => {
      const status = await engineFor("openai").status(LOCAL_USER_ID);
      assert.equal(status.id, "loop:openai");
      assert.equal(status.label, "OpenAI API");
      assert.equal(status.kind, "loop");
      assert.equal(status.billing, "api");
      assert.equal(status.ready, true);
      assert.deepEqual(status.models, ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "o5-mini"]);
      assert.equal(status.model, "gpt-6.1-sol");
      assert.equal(s.modelHits[0].headers.authorization, "Bearer sk-env-openai");
    });
  });

  test("Claude lists models that accept adaptive thinking", async () => {
    await withStand("anthropic", [], async () => {
      const status = await engineFor("anthropic").status(LOCAL_USER_ID);
      assert.deepEqual(status.models, ["claude-opus-5-5", "claude-sonnet-5-5"]);
      assert.equal(status.model, "claude-opus-5-5");
    });
  });

  test("Gemini drops the models/ prefix and non-chat models", async () => {
    await withStand("gemini", [], async () => {
      const status = await engineFor("gemini").status(LOCAL_USER_ID);
      assert.deepEqual(status.models, ["gemini-4-argon", "gemini-3.8-flash"]);
      assert.equal(status.model, "gemini-3.8-flash");
    });
  });

  test("OpenRouter asks for tool-capable models and skips batch and free variants", async () => {
    await withStand("openrouter", [], async (s) => {
      const status = await engineFor("openrouter").status(LOCAL_USER_ID);
      assert.deepEqual(status.models, ["anthropic/claude-opus-5.5", "openai/gpt-6.1-sol"]);
      assert.equal(status.model, "anthropic/claude-opus-5.5");
      assert.equal(s.hits.find((h) => h.path.endsWith("/models"))!.body, null);
      assert.ok(s.modelHits.length === 1);
    });
  });

  test("a model the person chose wins, and a run can name its own", async () => {
    await withStand("openai", [{ text: "Hi." }], async (s) => {
      accounts.setModel(LOCAL_USER_ID, "loop:openai", "gpt-6-luna");
      try {
        assert.equal((await engineFor("openai").status(LOCAL_USER_ID)).model, "gpt-6-luna");
        await engineFor("openai").turn(fakeIO({ model: "o5-mini" }), "Hello");
        assert.equal(s.chats[0].model, "o5-mini");
      } finally {
        accounts.setModel(LOCAL_USER_ID, "loop:openai", null);
      }
    });
  });

  test("without a preferred model in the list, the constant fallback is used", async () => {
    await withStand("gemini", [], async () => {
      const prev = GEMINI_MODELS.splice(0, GEMINI_MODELS.length, "models/gemini-3.5-flash-lite");
      try {
        const status = await engineFor("gemini").status(LOCAL_USER_ID);
        assert.deepEqual(status.models, ["gemini-3.5-flash-lite"]);
        assert.equal(status.model, "gemini-3.8-flash");
      } finally {
        GEMINI_MODELS.splice(0, GEMINI_MODELS.length, ...prev);
      }
    });
  });

  test("lists are cached per person and provider", async () => {
    await withStand("openai", [], async (s) => {
      const engine = engineFor("openai");
      await engine.status(LOCAL_USER_ID);
      await engine.status(LOCAL_USER_ID);
      assert.equal(s.modelHits.length, 1);
      await engine.status("someone-else");
      assert.equal(s.modelHits.length, 2);
    });
  });

  test("a provider that can't list models still leaves the engine ready", async () => {
    await withStand("openai", [], async (s) => {
      s.modelsStatus = 500;
      const status = await engineFor("openai").status(LOCAL_USER_ID);
      assert.equal(status.ready, true);
      assert.equal(status.models, undefined);
      assert.equal(status.model, "gpt-6.1-sol");
    });
  });

  test("says where the key comes from, and asks for one when there is none", async () => {
    const names = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
    for (const kind of KINDS) {
      await withStand(kind, [], async () => {
        assert.equal((await engineFor(kind).status(LOCAL_USER_ID)).detail, `Using ${names[kind]} from the server's environment`);
      });
    }
    await withStand("anthropic", [], async (s) => {
      accounts.setKey(LOCAL_USER_ID, "anthropic", "sk-ant-saved");
      try {
        const status = await engineFor("anthropic").status(LOCAL_USER_ID);
        assert.equal(status.detail, "Using your saved key");
        assert.equal(s.modelHits.at(-1)!.headers["x-api-key"], "sk-ant-saved");
      } finally {
        accounts.setKey(LOCAL_USER_ID, "anthropic", null);
      }
    });

    const bare = makeEnv(NO_KEYS);
    try {
      const none = apiEngines(bare.ctx, new EngineAccounts(bare.ctx));
      assert.deepEqual(
        none.map((e) => e.id),
        ["loop:openai", "loop:anthropic", "loop:gemini", "loop:openrouter"],
      );
      for (const engine of none) {
        const status = await engine.status(LOCAL_USER_ID);
        assert.equal(status.ready, false);
        assert.equal(status.needs, "key");
        assert.equal(status.detail, "Add an API key");
        assert.equal(status.models, undefined);
        const out = await engine.turn(fakeIO({}), "Hello");
        assert.equal(out.outcome, "failed");
      }
    } finally {
      bare.cleanup();
    }
  });
});
