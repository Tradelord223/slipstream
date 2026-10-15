import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import type { EngineAccounts } from "../src/agents/engines/accounts.ts";
import { chatgptEngine } from "../src/agents/engines/chatgpt.ts";
import type { ChatGPTAuth } from "../src/agents/engines/chatgpt-auth.ts";
import { fakeIO } from "./engine-io.ts";

/** The ChatGPT engine: sign-in tokens feed the Responses adapter in ChatGPT mode; a rejected token is refreshed once. */
describe("ChatGPT engine", () => {
  const seen: { auth: string; body: Record<string, unknown> }[] = [];
  let reject = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ slug: "gpt-6-luna", visibility: "list" }, { slug: "gpt-6.1-sol", visibility: "list" }, { slug: "internal-x", visibility: "hide" }] }));
    }
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ auth: req.headers.authorization!, body: JSON.parse(raw) });
    if (reject > 0) {
      reject -= 1;
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "invalid_token", message: "expired" } }));
    }
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Nothing urgent today." }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 4 } } })}\n\n`);
  });

  let token = "tok_1";
  const refreshed: string[] = [];
  const auth = {
    status: () => ({ signedIn: true, email: "ana@fernpoint.co", plan: "pro", pending: false }),
    accessToken: async () => token,
    refreshNow: async (_u: string, rejected?: string) => {
      refreshed.push(rejected ?? "");
      token = "tok_2";
      return token;
    },
  } as unknown as ChatGPTAuth;
  const accounts = { model: () => null } as unknown as EngineAccounts;

  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.SLIPSTREAM_OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  after(() => {
    server.close();
    delete process.env.SLIPSTREAM_OPENAI_BASE_URL;
  });

  test("status shows who's signed in and the plan's listed models", async () => {
    const s = await chatgptEngine(auth, accounts).status("usr_1");
    assert.equal(s.ready, true);
    assert.equal(s.detail, "Signed in as ana@fernpoint.co (pro)");
    assert.deepEqual(s.models, ["gpt-6-luna", "gpt-6.1-sol"]);
    assert.equal(s.model, "gpt-6.1-sol");
    assert.equal(s.billing, "plan");
  });

  test("a rejected token is refreshed once and the step retried, in ChatGPT mode", async () => {
    reject = 1;
    const io = fakeIO({});
    const out = await chatgptEngine(auth, accounts).turn(io, "Anything urgent?");
    assert.deepEqual(out, { outcome: "done" });
    assert.deepEqual(refreshed, ["tok_1"]);
    assert.deepEqual(io.said, ["Nothing urgent today."]);
    const [first, second] = seen.slice(-2);
    assert.equal(first!.auth, "Bearer tok_1");
    assert.equal(second!.auth, "Bearer tok_2");
    assert.equal(second!.body.store, false);
    assert.equal(second!.body.stream, true);
    assert.equal("max_output_tokens" in second!.body, false);
  });

  test("signed out: not ready, says how to sign in", async () => {
    const out = { ...auth, status: () => ({ signedIn: false, pending: false }) } as unknown as ChatGPTAuth;
    const s = await chatgptEngine(out, accounts).status("usr_1");
    assert.equal(s.ready, false);
    assert.equal(s.needs, "signin");
  });
});
