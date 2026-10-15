import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { agent, human, makeAgent, startServer, type Server } from "./harness.ts";

let server: Server;
let h: ReturnType<typeof human>;

before(async () => {
  server = await startServer();
  h = human(server.url);
});
after(async () => server.stop());

const inbox = async () => (await h("/api/threads?view=inbox&limit=100")).body.threads as { id: string; subject: string; inInbox: boolean }[];
const threadBySubject = async (s: string) => (await inbox()).find((t) => t.subject.includes(s))!;

describe("commands are discoverable", () => {
  test("the registry describes every command with a JSON Schema, and OpenAPI mirrors it", async () => {
    const list = (await h("/api/v1/commands")).body.commands as { name: string; scope: string; input: { type: string } }[];
    for (const name of ["mail.search", "mail.read", "triage.done", "triage.remind", "drafts.create", "drafts.send", "undo"])
      assert.ok(list.some((c) => c.name === name), `${name} is listed`);
    assert.ok(list.every((c) => c.input.type === "object"));
    const spec = (await h("/api/v1/openapi.json")).body;
    assert.equal(spec.openapi, "3.1.0");
    assert.equal(Object.keys(spec.paths).length, list.length);
  });

  test("an agent only sees commands its scopes allow", async () => {
    const { token } = await makeAgent(server.url, "Reader", ["read"]);
    const list = (await agent(server.url, token)("/api/v1/commands")).body.commands as { scope: string }[];
    assert.ok(list.length > 0);
    assert.ok(list.every((c) => c.scope === "read"));
  });
});

describe("scopes and boundaries", () => {
  test("a read-only agent can search but not triage, and can't reach the dashboard API", async () => {
    const { token } = await makeAgent(server.url, "Read only", ["read"]);
    const a = agent(server.url, token);
    const found = await a("/api/v1/mail.search", { query: "from:priya" });
    assert.equal(found.status, 200);
    assert.ok(found.body.result.threads.length > 0);
    const t = found.body.result.threads[0].id;
    assert.equal((await a("/api/v1/triage.done", { threadIds: [t] })).status, 403);
    assert.equal((await a("/api/bootstrap")).status, 403);
    assert.equal((await a("/api/agents")).status, 403);
    assert.equal((await a("/api/v1/approvals")).status, 403);
  });

  test("bad or revoked tokens are refused; /mcp without a token points at auth metadata", async () => {
    assert.equal((await agent(server.url, "ss_agent_nope")("/api/v1/commands")).status, 401);
    const made = await makeAgent(server.url, "Temporary", ["read"]);
    assert.equal((await h(`/api/agents/${made.agent.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await agent(server.url, made.token)("/api/v1/commands")).status, 401);
    const res = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });

  test("the dashboard API still requires its client header", async () => {
    const res = await fetch(`${server.url}/api/bootstrap`);
    assert.equal(res.status, 403);
  });
});

describe("attribution and undo", () => {
  test("an agent's triage shows in the activity log under its name and can be undone by a person", async () => {
    const { token } = await makeAgent(server.url, "Inbox agent", ["read", "triage"]);
    const a = agent(server.url, token);
    const t = await threadBySubject("Coffee next week?");
    const done = await a("/api/v1/triage.done", { threadIds: [t.id] });
    assert.equal(done.status, 200);
    assert.ok(done.body.activityId);
    assert.ok(!(await inbox()).some((x) => x.id === t.id), "left the inbox");

    const activity = (await h(`/api/v1/activity?threadId=${t.id}`)).body.activity as { id: string; actor: { name: string; kind: string }; summary: string; canUndo: boolean }[];
    assert.equal(activity[0]!.actor.name, "Inbox agent");
    assert.equal(activity[0]!.actor.kind, "agent");
    assert.match(activity[0]!.summary, /Coffee next week\?/);
    assert.ok(activity[0]!.canUndo);

    assert.equal((await h(`/api/v1/activity/${done.body.activityId}/undo`, { method: "POST" })).status, 200);
    assert.ok((await inbox()).some((x) => x.id === t.id), "back in the inbox");
  });

  test("the dashboard's own actions are recorded too", async () => {
    const t = await threadBySubject("Sunday dinner");
    const r = await h("/api/triage", { method: "POST", json: { kind: "star", threadIds: [t.id] } });
    assert.ok(r.body.undoToken);
    const activity = (await h(`/api/v1/activity?threadId=${t.id}`)).body.activity as { actor: { kind: string } }[];
    assert.equal(activity[0]!.actor.kind, "human");
  });
});

describe("approvals", () => {
  test("an agent's send waits in the Review queue until a person approves it", async () => {
    const { token } = await makeAgent(server.url, "Drafter", ["read", "draft", "send"]);
    const a = agent(server.url, token);
    const t = await threadBySubject("Can you review the onboarding copy?");
    const draft = await a("/api/v1/drafts.create", { threadId: t.id, body: "Good to go — ship it." });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.result.to[0].email, "sam@fernpoint.co");
    assert.match(draft.body.result.subject, /^Re: /);

    const send = await a("/api/v1/drafts.send", { draftId: draft.body.result.id });
    assert.equal(send.status, 202);
    assert.equal(send.body.status, "pending_approval");

    const queue = (await h("/api/v1/approvals")).body.approvals as { id: string; preview: string; agent: { name: string }; threadIds: string[] }[];
    const item = queue.find((q) => q.id === send.body.approvalId)!;
    assert.equal(item.agent.name, "Drafter");
    assert.deepEqual(item.threadIds, [t.id], "the approval knows its conversation");
    assert.match(item.preview, /To: .*sam@fernpoint\.co/);
    assert.match(item.preview, /Good to go/);
    assert.equal((await h(`/api/drafts/${draft.body.result.id}`)).body.status, "draft", "nothing sent before approval");

    const approved = await h(`/api/v1/approvals/${item.id}/approve`, { method: "POST" });
    assert.equal(approved.status, 200);
    assert.equal((await h(`/api/drafts/${draft.body.result.id}`)).body.status, "scheduled");
    assert.equal((await h(`/api/v1/approvals/${item.id}/approve`, { method: "POST" })).status, 409, "can't approve twice");
  });

  test("rejecting leaves the draft unsent; an agent can't approve its own request", async () => {
    const { token } = await makeAgent(server.url, "Eager", ["read", "draft", "send"]);
    const a = agent(server.url, token);
    const accounts = (await a("/api/v1/accounts.list", {})).body.result as { id: string }[];
    const d = await a("/api/v1/drafts.create", { accountId: accounts[0]!.id, to: ["lena.hart@gmail.example"], subject: "Hi", body: "Hello" });
    const send = await a("/api/v1/drafts.send", { draftId: d.body.result.id });
    assert.equal((await a(`/api/v1/approvals/${send.body.approvalId}/approve`, {})).status, 403);
    assert.equal((await h(`/api/v1/approvals/${send.body.approvalId}/reject`, { method: "POST" })).status, 200);
    assert.equal((await h(`/api/drafts/${d.body.result.id}`)).body.status, "draft");
  });

  test("if the draft changes after the request, approving refuses instead of sending something unreviewed", async () => {
    const { token } = await makeAgent(server.url, "Sneaky", ["read", "draft", "send"]);
    const a = agent(server.url, token);
    const accounts = (await a("/api/v1/accounts.list", {})).body.result as { id: string }[];
    const d = await a("/api/v1/drafts.create", { accountId: accounts[0]!.id, to: ["sam@fernpoint.co"], subject: "Lunch", body: "Pizza on Friday?" });
    const send = await a("/api/v1/drafts.send", { draftId: d.body.result.id });
    await a("/api/v1/drafts.update", { draftId: d.body.result.id, body: "Something else entirely" });
    const res = await h(`/api/v1/approvals/${send.body.approvalId}/approve`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.equal((await h(`/api/drafts/${d.body.result.id}`)).body.status, "draft");
  });

  test("an agent can't dodge the bulk limit by splitting it into small calls", async () => {
    const { token } = await makeAgent(server.url, "Splitter", ["read", "triage"], { bulkThreshold: 2 });
    const a = agent(server.url, token);
    const done = (await a("/api/v1/mail.search", { query: "in:done", limit: 30 })).body.result.threads as { id: string }[];
    const ids = done.slice(10, 13).map((t) => t.id);
    assert.equal((await a("/api/v1/triage.trash", { threadIds: ids.slice(0, 2) })).status, 200);
    assert.equal((await a("/api/v1/triage.trash", { threadIds: ids.slice(2, 3) })).status, 202, "the 10-minute window adds up");
  });

  test("a send's review shows where links go, which images load, and which account sends it", async () => {
    const { token } = await makeAgent(server.url, "Linker", ["read", "draft", "send"]);
    const a = agent(server.url, token);
    const accounts = (await a("/api/v1/accounts.list", {})).body.result as { id: string; email: string }[];
    const d = await a("/api/v1/drafts.create", {
      accountId: accounts[0]!.id,
      to: ["sam@fernpoint.co"],
      subject: "Notes",
      bodyHtml: '<p>Notes are <a href="https://evil.example/x?u=1">here</a>.<img src="https://track.example/p.gif"></p>',
    });
    const send = await a("/api/v1/drafts.send", { draftId: d.body.result.id });
    const item = ((await h("/api/v1/approvals")).body.approvals as { id: string; preview: string }[]).find((q) => q.id === send.body.approvalId)!;
    assert.match(item.preview, /here \(https:\/\/evil\.example\/x\?u=1\)/);
    assert.match(item.preview, /\[image: https:\/\/track\.example\/p\.gif\]/);
    assert.match(item.preview, new RegExp(`From: .*${accounts[0]!.email.replace(".", "\\.")}`));
    await h(`/api/v1/approvals/${item.id}/reject`, { method: "POST" });
  });

  test("bulk trash over the agent's threshold needs approval; small trash doesn't", async () => {
    const { token } = await makeAgent(server.url, "Cleaner", ["read", "triage"], { bulkThreshold: 2 });
    const a = agent(server.url, token);
    const done = (await a("/api/v1/mail.search", { query: "in:done", limit: 5 })).body.result.threads as { id: string }[];
    assert.ok(done.length >= 3);
    assert.equal((await a("/api/v1/triage.trash", { threadIds: done.slice(0, 3).map((t) => t.id) })).status, 202);
    assert.equal((await a("/api/v1/triage.trash", { threadIds: done.slice(3, 5).map((t) => t.id) })).status, 200);
  });

  test("changing one policy field keeps the others", async () => {
    const created = (await h("/api/agents", { method: "POST", json: { name: "Careful", scopes: ["read"], policy: { bulkThreshold: 3, settings: "allow" } } })).body.agent;
    const updated = (await h(`/api/agents/${created.id}`, { method: "PATCH", json: { policy: { send: "never" } } })).body.agent;
    assert.deepEqual(updated.policy, { send: "never", bulkThreshold: 3, settings: "allow" });
  });
});

describe("MCP", () => {
  test("Streamable HTTP with a bearer token: tools follow scopes, calls run through the registry", async () => {
    const { token } = await makeAgent(server.url, "MCP agent", ["read", "draft", "send"]);
    const client = new Client({ name: "contract", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("mail_search") && names.includes("drafts_send"));
    assert.ok(!names.some((n) => n.startsWith("triage_")), "no triage scope, no triage tools");
    const res = (await client.callTool({ name: "mail_search", arguments: { query: "lane grouping" } })) as { content: { text: string }[] };
    assert.match(res.content[0]!.text, /Dispatch dashboard/);
    const bad = (await client.callTool({ name: "mail_read", arguments: { threadId: "thr_missing" } })) as { isError?: boolean };
    assert.equal(bad.isError, true);
    await client.close();
  });

  test("the stdio bridge (slipstream mcp) exposes the same tools", async () => {
    const { token } = await makeAgent(server.url, "Stdio agent", ["read"]);
    const client = new Client({ name: "contract-stdio", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["server/src/cli.ts", "mcp"],
        env: { ...process.env, SLIPSTREAM_URL: server.url, SLIPSTREAM_TOKEN: token } as Record<string, string>,
      }),
    );
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "mail_search"));
    const res = (await client.callTool({ name: "mail_counts", arguments: {} })) as { content: { text: string }[] };
    assert.match(res.content[0]!.text, /"inbox"/);
    await client.close();
  });
});

describe("CLI", () => {
  test("slipstream <command> --flags prints the JSON result", async () => {
    const { token } = await makeAgent(server.url, "CLI agent", ["read"]);
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ["server/src/cli.ts", "mail.search", "--query", "from:priya", "--limit", "5"], {
        env: { ...process.env, SLIPSTREAM_URL: server.url, SLIPSTREAM_TOKEN: token },
      });
      let s = "";
      p.stdout.on("data", (d) => (s += d));
      p.on("exit", (code) => (code === 0 ? resolve(s) : reject(new Error(`exit ${code}: ${s}`))));
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, "done");
    assert.ok(parsed.result.threads.length > 0);
  });
});

describe("webhooks", () => {
  test("events are delivered and signed with the webhook's secret", async () => {
    const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
    const receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    const port = (receiver.address() as { port: number }).port;
    try {
      const hook = await h("/api/webhooks", { method: "POST", json: { url: `http://127.0.0.1:${port}/hook`, events: ["activity"] } });
      assert.equal(hook.status, 200);
      const t = await threadBySubject("Sunday dinner");
      await h("/api/triage", { method: "POST", json: { kind: "unstar", threadIds: [t.id] } });
      for (let i = 0; i < 40 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(received.length >= 1, "delivered");
      const { headers, body } = received[0]!;
      assert.equal(headers["x-slipstream-event"], "activity");
      const expected = `v1=${createHmac("sha256", hook.body.secret).update(`${headers["x-slipstream-timestamp"]}.${body}`).digest("hex")}`;
      assert.equal(headers["x-slipstream-signature"], expected);
      assert.equal(JSON.parse(body).type, "activity");
    } finally {
      receiver.close();
    }
  });
});

describe("fast paths for agents", () => {
  test("mail.digest orients an agent in one call; search results are compact by default", async () => {
    const { token } = await makeAgent(server.url, "Orienter", ["read"]);
    const a = agent(server.url, token);
    const d = (await a("/api/v1/mail.digest", { perSplit: 3 })).body.result;
    assert.ok(d.inbox.total > 0);
    assert.ok(d.splits.length >= 2 && d.splits[0].newest.length <= 3);
    assert.ok(Array.isArray(d.labels));
    const compact = (await a("/api/v1/mail.search", { query: "from:priya" })).body.result.threads[0];
    assert.ok(compact.id && compact.subject && compact.at);
    assert.equal(compact.participants, undefined, "compact rows leave out the heavy fields");
    const full = (await a("/api/v1/mail.search", { query: "from:priya", detail: "full" })).body.result.threads[0];
    assert.ok(Array.isArray(full.participants));
  });

  test("batch runs several commands in one round trip, each independent", async () => {
    const { token } = await makeAgent(server.url, "Batcher", ["read", "triage"]);
    const a = agent(server.url, token);
    const ids = ((await a("/api/v1/mail.search", { query: "in:inbox", limit: 2 })).body.result.threads as { id: string }[]).map((t) => t.id);
    const r = await a("/api/v1/batch", {
      commands: [
        { command: "labels.create", input: { name: "Batched", color: "#B79CFF" } },
        { command: "triage.label", input: { threadIds: ids, label: "Batched" } },
        { command: "drafts.send", input: { draftId: "nope" } },
        { command: "labels.list", input: {} },
      ],
    });
    assert.equal(r.status, 200);
    const results = r.body.results as { status: string; httpStatus?: number; result?: unknown }[];
    assert.deepEqual(results.map((x) => x.status), ["done", "done", "error", "done"]);
    assert.equal(results[2]!.httpStatus, 403, "no send scope");
    assert.ok((results[3]!.result as { name: string; count: number }[]).some((l) => l.name === "Batched" && l.count === ids.length));
  });
});
