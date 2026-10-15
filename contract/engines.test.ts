import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { human, startServer, type Server } from "./harness.ts";

/**
 * Agents on every kind of engine, end to end against a running server: an API engine (a stand-in
 * for OpenAI's Responses API) and the person's own Claude Code and Codex (scripted binaries that
 * call Slipstream's /mcp with the run's token). Each searches, drafts a reply and asks to send,
 * and the send must wait in Review. Then Autopilot sorts the demo inbox on the API engine.
 *
 * These need stand-ins inside the server's environment, so they're skipped against an external server.
 */

type Item = { type?: string; role?: string; content?: unknown; call_id?: string; output?: string; name?: string; arguments?: string };

/** The model: decides what to do next from the conversation so far, like a sensible agent would. */
function nextStep(input: Item[]): Item[] {
  const lastUser = input.map((i) => i.role).lastIndexOf("user");
  const ask = String(input[lastUser]!.content);
  const outputs = input.slice(lastUser + 1).filter((i) => i.type === "function_call_output").map((i) => i.output!);
  const call = (name: string, args: unknown): Item => ({ type: "function_call", call_id: `call_${outputs.length}_${name}`, name, arguments: JSON.stringify(args) });
  const say = (text: string): Item => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

  if (ask.includes("<conversation id=")) {
    if (outputs.length) return [say("Sorted.")];
    const ids = [...ask.matchAll(/<conversation id="([^"]+)" category="([^"]+)"/g)].map((m) => ({ id: m[1]!, category: m[2]! }));
    return [
      call("autopilot_decide", {
        decisions: ids.map((c) =>
          c.category === "important"
            ? { threadId: c.id, action: "keep", needsReply: true, summary: "Someone wrote to you", reason: "A person is waiting on you", confidence: 0.9 }
            : { threadId: c.id, action: "done", priority: "low", summary: "Automated mail", reason: "Sent by a machine; nothing to do", confidence: 0.9 },
        ),
      }),
    ];
  }
  if (ask.startsWith("You are Autopilot, drafting")) {
    const first = /^Conversation (\S+):/m.exec(ask)![1]!;
    if (outputs.length === 0) return [call("mail_read", { threadId: first })];
    if (outputs.length === 1) return [call("drafts_create", { threadId: first, body: "Thanks. [time] works for me." })];
    return [say("Drafted one reply.")];
  }
  if (outputs.length === 0) return [call("mail_search", { query: "Dispatch", limit: 1 })];
  if (outputs.length === 1) return [call("drafts_create", { threadId: JSON.parse(outputs[0]!).threads[0].id, body: "Thanks, that works for us." })];
  if (outputs.length === 2) return [call("drafts_send", { draftId: JSON.parse(outputs[1]!).id })];
  return [say("Drafted a reply and asked you to approve sending it.")];
}

function standInOpenAI() {
  const requests: { model: string; store: boolean; tools: { name: string }[] }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model: string; store: boolean; input: Item[]; tools: { name: string }[] };
    requests.push(body);
    const items = nextStep(body.input);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of items) res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: items, usage: { input_tokens: 100, output_tokens: 20 } } })}\n\n`);
  });
  return { server, requests };
}

const external = Boolean(process.env.SLIPSTREAM_CONTRACT_URL);

describe("agents on every engine", { skip: external && "needs stand-ins inside the server" }, () => {
  let server: Server;
  let h: ReturnType<typeof human>;
  const openai = standInOpenAI();
  const tokenLog = join(mkdtempSync(join(tmpdir(), "slipstream-tokens-")), "tokens.txt");

  before(async () => {
    await new Promise<void>((r) => openai.server.listen(0, "127.0.0.1", r));
    const port = (openai.server.address() as { port: number }).port;
    server = await startServer({
      env: {
        OPENAI_API_KEY: "sk-test-stand-in",
        SLIPSTREAM_OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        SLIPSTREAM_CLAUDE_BIN: resolve("contract/fixtures/scripted-claude.mjs"),
        SLIPSTREAM_CODEX_BIN: resolve("contract/fixtures/scripted-codex.mjs"),
        TOKEN_LOG: tokenLog,
      },
    });
    h = human(server.url);
  });
  after(async () => {
    await server?.stop();
    openai.server.close();
  });

  const runToEnd = async (engine: string) => {
    const started = await h("/api/cloud/runs", { method: "POST", json: { instruction: "Reply to the Dispatch thread and send it.", engine } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    for (let i = 0; i < 200; i++) {
      const run = (await h(`/api/cloud/runs/${started.body.id}`)).body;
      if (run.status !== "running" && run.status !== "starting") return run;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("run didn't finish");
  };

  test("Models & accounts lists every engine with its state", async () => {
    const { body } = await h("/api/engines");
    const byId = Object.fromEntries((body.engines as { id: string; ready: boolean; needs?: string; billing: string }[]).map((e) => [e.id, e]));
    assert.deepEqual(Object.keys(byId).sort(), ["cli:claude-code", "cli:codex", "loop:anthropic", "loop:chatgpt", "loop:gemini", "loop:openai", "loop:openrouter", "managed:anthropic"]);
    assert.equal(byId["loop:openai"].ready, true, "the environment's key");
    assert.equal(byId["loop:chatgpt"].needs, "signin");
    assert.equal(byId["cli:claude-code"].ready, true);
    assert.equal(byId["cli:codex"].billing, "plan");
    assert.equal(body.keys.openai, "environment");
  });

  for (const [engine, name] of [
    ["loop:openai", "OpenAI API"],
    ["cli:claude-code", "Claude Code"],
    ["cli:codex", "Codex"],
  ] as const) {
    test(`${name}: searches, drafts, and the send waits in Review`, async () => {
      const run = await runToEnd(engine);
      assert.equal(run.status, "done", run.error);
      assert.equal(run.engine, engine);
      assert.deepEqual(
        run.transcript.filter((t: { kind: string }) => t.kind === "tool").map((t: { text: string }) => t.text),
        ["mail.search", "drafts.create", "drafts.send"],
      );
      assert.match(run.transcript.at(-1).text, /approve sending/);
      const pending = (await h("/api/v1/approvals?status=pending")).body.approvals as { runId: string; agent: { name: string }; command: string }[];
      const mine = pending.find((a) => a.runId === run.id);
      assert.ok(mine, "the send is waiting in Review, linked to the run");
      assert.equal(mine.command, "drafts.send");
      assert.equal(mine.agent.name, name, "attributed to the engine");
    });
  }

  test("a CLI's run-scoped token stops working when the run ends", async () => {
    const tokens = readFileSync(tokenLog, "utf8").trim().split("\n");
    assert.ok(tokens.length >= 2);
    for (const token of tokens) {
      const res = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(res.status, 401);
    }
  });

  test("API requests keep nothing on OpenAI's side and offer only the agent's tools", () => {
    assert.ok(openai.requests.every((r) => r.store === false && r.model === "gpt-6.1-sol"));
    assert.ok(openai.requests[0]!.tools.some((t) => t.name === "drafts_send"));
  });

  test("Autopilot sorts the inbox on the chosen engine: machines out, people kept, replies drafted", async () => {
    const on = await h("/api/autopilot", { method: "PUT", json: { enabled: true, mode: "auto", engine: "loop:openai" } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    await h("/api/autopilot/backfill", { method: "POST", json: { days: 30 } });
    let o: any;
    for (let i = 0; i < 300; i++) {
      o = (await h("/api/autopilot")).body;
      const settled = o.items.length > 0 && !o.running && o.items.every((x: { stage: string }) => x.stage === "decided") && o.items.some((x: { draftId: string | null }) => x.draftId);
      if (settled) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(o.problem, null);
    const items = o.items as { decision: { action: string; reason: string; needsReply: boolean }; applied: boolean; inInbox: boolean; draftId: string | null }[];
    assert.ok(items.length >= 5, `processed ${items.length}`);
    assert.ok(items.every((i) => i.decision.reason));
    assert.ok(items.some((i) => i.decision.action === "done" && i.applied && !i.inInbox), "automated mail left the inbox");
    assert.ok(items.some((i) => i.decision.action === "keep" && i.inInbox), "people stayed");
    assert.ok(items.some((i) => i.draftId), "a reply was drafted");
    const pilot = (await h("/api/agents")).body.agents.find((a: { name: string }) => a.name === "Autopilot");
    assert.deepEqual(pilot.scopes, ["read", "triage", "draft"], "Autopilot can't send");
  });
});
