import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { nextScheduled, zonedTimeToUtc } from "../src/agents/cloud.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";

/**
 * A stand-in for the Managed Agents API: environments, agents, sessions, and a scripted agent that
 * searches the inbox, then marks what it found done, using Slipstream's commands as custom tools.
 */
class FakeManagedAgents {
  calls: { method: string; path: string; body: any }[] = [];
  agentVersion = 0;
  sessions = new Map<string, { events: any[]; listeners: Set<ServerResponse>; step: number }>();
  server = createServer((req, res) => void this.handle(req, res));
  url = "";

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  private emit(sid: string, event: any) {
    const s = this.sessions.get(sid)!;
    const full = { id: `sevt_${s.events.length + 1}`, processed_at: new Date().toISOString(), ...event };
    s.events.push(full);
    for (const l of s.listeners) l.write(`event: ${full.type}\ndata: ${JSON.stringify(full)}\n\n`);
  }

  /** The scripted agent: step 0 search, step 1 mark done, step 2 report. */
  private advance(sid: string, lastResult?: string) {
    const s = this.sessions.get(sid)!;
    if (s.step === 0) {
      this.emit(sid, { type: "agent.custom_tool_use", name: "mail_search", input: { query: "from:priya", limit: 5 } });
      this.emit(sid, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [] } });
    } else if (s.step === 1) {
      const ids = (JSON.parse(lastResult!).threads as { id: string }[]).map((t) => t.id);
      this.emit(sid, { type: "agent.custom_tool_use", name: "triage_done", input: { threadIds: ids } });
      this.emit(sid, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [] } });
    } else {
      this.emit(sid, { type: "agent.message", content: [{ type: "text", text: "- Marked Priya's conversation done." }] });
      this.emit(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
    }
    s.step += 1;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://x");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    this.calls.push({ method: req.method!, path: url.pathname, body });
    const json = (o: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const p = url.pathname;
    if (req.method === "POST" && p === "/v1/environments") return json({ id: "env_1", type: "environment", name: body.name });
    if (req.method === "POST" && p === "/v1/agents") return json({ id: "agent_1", type: "agent", version: ++this.agentVersion, ...body });
    if (req.method === "POST" && p === "/v1/agents/agent_1") return json({ id: "agent_1", type: "agent", version: ++this.agentVersion });
    if (req.method === "POST" && p === "/v1/sessions") {
      const sid = `sesn_${this.sessions.size + 1}`;
      this.sessions.set(sid, { events: [], listeners: new Set(), step: 0 });
      for (const e of body.initial_events ?? []) this.emit(sid, e);
      setTimeout(() => this.advance(sid), 20);
      return json({ id: sid, type: "session", status: "running" });
    }
    const m = /^\/v1\/sessions\/(sesn_\d+)(\/events(\/stream)?)?$/.exec(p);
    if (m) {
      const s = this.sessions.get(m[1]!)!;
      if (m[3]) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        s.listeners.add(res);
        req.on("close", () => s.listeners.delete(res));
        return;
      }
      if (m[2] && req.method === "GET") return json({ data: s.events, next_page: null });
      if (m[2] && req.method === "POST") {
        for (const e of body.events) {
          this.emit(m[1]!, e);
          if (e.type === "user.custom_tool_result") setTimeout(() => this.advance(m[1]!, e.content[0].text), 10);
        }
        return json({ data: [] });
      }
      return json({ id: m[1], type: "session", status: "idle", usage: { list_cost: { amount: "37", currency: "USD" } } });
    }
    res.writeHead(404).end("{}");
  }
}

// Generous: under a loaded machine (CI, parallel suites) a run can take a few seconds to settle.
const waitFor = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("managed cloud agent", () => {
  const fake = new FakeManagedAgents();
  let env: TestEnv;
  let account: AccountRow;

  before(async () => {
    await fake.listen();
    process.env.SLIPSTREAM_ANTHROPIC_BASE_URL = fake.url;
    env = makeEnv();
    account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID))!;
    env.ctx.store.ingest(account, {
      messages: [msg({ from: { name: "Priya", email: "priya@kettleby.test" }, subject: "Round 2 feedback", remoteThreadId: "p1" })],
      cursor: null,
      done: true,
    });
  });
  after(() => {
    env.ctx.cloud.close();
    env.cleanup();
    fake.server.close();
    delete process.env.SLIPSTREAM_ANTHROPIC_BASE_URL;
  });

  test("linking with an API key creates the agent once, with tools matching its scopes and a locked-down environment", async () => {
    const r = await env.api("/api/cloud/connect", { method: "POST", json: { apiKey: "sk-ant-test", scopes: ["read", "triage", "draft"] } });
    assert.equal(r.status, 200);
    const status = await r.json();
    assert.equal(status.connected, true);
    assert.equal(status.agent.name, "Claude (cloud)");

    const created = fake.calls.find((c) => c.path === "/v1/agents")!.body;
    assert.equal(created.model.id, "claude-opus-5-5");
    const tools = (created.tools as { type: string; name: string }[]).map((t) => t.name);
    assert.ok(tools.includes("mail_search") && tools.includes("triage_done") && tools.includes("drafts_create"));
    assert.ok(!tools.includes("drafts_send"), "no send scope, no send tool");
    assert.ok((created.tools as { type: string }[]).every((t) => t.type === "custom"), "only Slipstream's own tools");
    assert.deepEqual(fake.calls.find((c) => c.path === "/v1/environments")!.body.config.networking, { type: "limited" });

    // The key is stored sealed and never returned.
    const boot = await (await env.api("/api/bootstrap")).json();
    assert.doesNotMatch(JSON.stringify(boot), /sk-ant-test/);
  });

  test("a run answers the agent's tool calls through Slipstream: attributed, capped, costed", async () => {
    const started = await (await env.api("/api/cloud/runs", { method: "POST", json: { instruction: "Mark Priya's mail done" } })).json();
    const sessionCreate = fake.calls.find((c) => c.path === "/v1/sessions")!.body;
    assert.deepEqual(sessionCreate.budget, { type: "limit", max_list_cost: { amount: "100", currency: "USD" } });
    assert.match(sessionCreate.initial_events[0].content[0].text, /Mark Priya's mail done/);

    await waitFor(() => env.ctx.cloud.run(LOCAL_USER_ID, started.id).status === "done");
    const run = env.ctx.cloud.run(LOCAL_USER_ID, started.id);
    assert.equal(run.toolCalls, 2);
    assert.ok(run.transcript.some((t) => t.kind === "agent" && /Marked Priya/.test(t.text)));
    await waitFor(() => env.ctx.cloud.run(LOCAL_USER_ID, started.id).costCents === 37);

    const thread = env.ctx.db.get<{ id: string; in_inbox: number }>("SELECT id, in_inbox FROM threads WHERE remote_id = 'p1'")!;
    assert.equal(thread.in_inbox, 0, "the agent's triage happened");
    const activity = env.ctx.commands.activity(LOCAL_USER_ID, { threadId: thread.id });
    assert.equal(activity[0]!.actor.name, "Claude (cloud)");
    assert.ok(activity[0]!.canUndo);
  });

  test("changing scopes updates the same agent in place", async () => {
    await env.api("/api/cloud/connect", { method: "POST", json: { scopes: ["read", "triage", "draft", "send"] } });
    assert.equal(fake.calls.filter((c) => c.path === "/v1/agents").length, 1, "not re-created");
    const update = fake.calls.find((c) => c.path === "/v1/agents/agent_1")!.body;
    assert.ok((update.tools as { name: string }[]).some((t) => t.name === "drafts_send"));
  });

  test("a mail routine runs when matching mail arrives", async () => {
    const r = await env.api("/api/cloud/routines", {
      method: "POST",
      json: { name: "Client mail", instruction: "Draft replies to these.", trigger: { type: "mail", query: "from:@kettleby.test" } },
    });
    assert.equal(r.status, 200);
    const before = fake.sessions.size;
    await env.ctx.cloud.tick();
    assert.equal(fake.sessions.size, before, "nothing new yet");
    await new Promise((r) => setTimeout(r, 5));
    env.ctx.store.ingest(account, {
      messages: [msg({ from: { name: "Devon", email: "devon@kettleby.test" }, subject: "Load board export", remoteThreadId: "p2", sentAt: Date.now() })],
      cursor: null,
      done: true,
    });
    await env.ctx.cloud.tick();
    assert.equal(fake.sessions.size, before + 1);
    const text = fake.calls.filter((c) => c.path === "/v1/sessions").at(-1)!.body.initial_events[0].content[0].text as string;
    assert.match(text, /Draft replies to these/);
    assert.match(text, /Load board export/);
  });

  test("the monthly budget stops new runs", async () => {
    await env.api("/api/cloud/connect", { method: "POST", json: { scopes: ["read"], monthlyBudgetCents: 100 } });
    env.ctx.db.run("UPDATE cloud_runs SET cost_cents = 150");
    const r = await env.api("/api/cloud/runs", { method: "POST", json: { instruction: "Anything" } });
    assert.equal(r.status, 402);
  });
});

describe("routine schedules", () => {
  test("local times convert across daylight saving", () => {
    assert.equal(new Date(zonedTimeToUtc(2026, 7, 15, 8, 0, "America/New_York")).toISOString(), "2026-07-15T12:00:00.000Z");
    assert.equal(new Date(zonedTimeToUtc(2026, 12, 15, 8, 0, "America/New_York")).toISOString(), "2026-12-15T13:00:00.000Z");
  });

  test("next weekday at 8:00 in the user's zone", () => {
    // Friday 2026-10-16 09:00 New York → next weekday 08:00 is Monday 2026-10-19.
    const from = Date.parse("2026-10-16T13:00:00Z");
    assert.equal(new Date(nextScheduled([1, 2, 3, 4, 5], "08:00", "America/New_York", from)).toISOString(), "2026-10-19T12:00:00.000Z");
  });
});
