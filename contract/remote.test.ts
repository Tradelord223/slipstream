import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { human, startServer, type Server } from "./harness.ts";

/**
 * A remote assistant (think claude.ai) connecting through the public listener: register, authorize,
 * wait for the person to approve in Review, exchange the code, call MCP. Local servers expose the
 * public listener on port + 1.
 */

let server: Server;
let pub: string;
let h: ReturnType<typeof human>;

before(async () => {
  server = await startServer();
  const u = new URL(server.url);
  pub = `${u.protocol}//${u.hostname}:${Number(u.port) + 1}`;
  h = human(server.url);
});
after(async () => server.stop());

const REDIRECT = "http://127.0.0.1:65530/callback";

async function register() {
  const r = await fetch(`${pub}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
  });
  assert.equal(r.status, 201);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function authorize(clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${pub}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${pub}/mcp`,
  }))
    url.searchParams.set(k, v);
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 200);
  const html = await res.text();
  const requestId = /data-id="([^"]+)"/.exec(html)![1]!;
  const pairing = /class="code"[^>]*>([A-Z0-9]{6})</.exec(html)![1]!;
  return { verifier, requestId, pairing };
}

const poll = async (id: string) => (await (await fetch(`${pub}/oauth/authorize/status?id=${encodeURIComponent(id)}`)).json()) as { status: string; redirect?: string };

const token = (form: Record<string, string>) =>
  fetch(`${pub}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

describe("remote assistants over OAuth", () => {
  test("discovery documents point at this listener", async () => {
    const pr = await (await fetch(`${pub}/.well-known/oauth-protected-resource`)).json();
    assert.equal(pr.resource, `${pub}/mcp`);
    const as = await (await fetch(`${pub}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.equal(as.token_endpoint, `${pub}/oauth/token`);
    const unauth = await fetch(`${pub}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${pub}/.well-known/oauth-protected-resource"`));
  });

  test("request headers can't choose the issuer, and unknown hosts are refused", async () => {
    const md = await (await fetch(`${pub}/.well-known/oauth-authorization-server`, { headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } })).json();
    assert.equal(md.issuer, pub);
    // fetch() won't send a custom Host header; use a raw request.
    const u = new URL(pub);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: u.hostname, port: u.port, path: "/.well-known/oauth-authorization-server", headers: { host: "rebound.example:80" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 421);
  });

  test("the public listener never serves the dashboard or its API", async () => {
    assert.equal((await fetch(`${pub}/api/bootstrap`, { headers: { "x-slipstream": "1" } })).status, 404);
    assert.doesNotMatch(await (await fetch(`${pub}/`)).text(), /<html/i);
  });

  test("connect: approve in Review by pairing code, exchange the code, use MCP, refresh with rotation", async () => {
    const clientId = await register();
    const { verifier, requestId, pairing } = await authorize(clientId);
    assert.equal((await poll(requestId)).status, "pending");

    const queue = (await h("/api/v1/approvals")).body.approvals as { id: string; command: string; preview: string; agent: { name: string } }[];
    const req = queue.find((a) => a.command === "oauth.connect" && a.preview.includes(pairing))!;
    assert.ok(req, "the request is in Review with its pairing code");
    assert.equal(req.agent.name, "Claude");
    assert.equal((await h(`/api/v1/approvals/${req.id}/approve`, { method: "POST" })).status, 200);

    const done = await poll(requestId);
    assert.equal(done.status, "approved");
    const back = new URL(done.redirect!);
    assert.equal(back.searchParams.get("state"), "xyz");
    const code = back.searchParams.get("code")!;
    assert.equal((await poll(requestId)).status, "used", "the code is handed out once");

    const wrong = await token({ grant_type: "authorization_code", code, code_verifier: "not-the-verifier-0000000000000000000000000", redirect_uri: REDIRECT, client_id: clientId });
    assert.equal(wrong.status, 400);
    // A failed exchange burns the code too.
    assert.equal((await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId })).status, 400);

    // Run the flow again properly.
    const second = await authorize(clientId);
    const queue2 = (await h("/api/v1/approvals")).body.approvals as { id: string; preview: string }[];
    await h(`/api/v1/approvals/${queue2.find((a) => a.preview.includes(second.pairing))!.id}/approve`, { method: "POST" });
    const code2 = new URL((await poll(second.requestId)).redirect!).searchParams.get("code")!;
    const tok = await token({ grant_type: "authorization_code", code: code2, code_verifier: second.verifier, redirect_uri: REDIRECT, client_id: clientId });
    assert.equal(tok.status, 200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    assert.equal(t.expires_in, 3600);
    assert.equal(t.scope, "read triage draft");

    const client = new Client({ name: "remote", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${pub}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t.access_token}` } } }));
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("mail_search") && names.includes("drafts_create"));
    assert.ok(!names.includes("drafts_send"), "no send scope by default");
    await client.close();

    const refreshed = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    assert.equal(refreshed.status, 200);
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status, 400, "rotated refresh tokens stop working");

    // The connection is an agent the person can see and revoke.
    const listed = (await h("/api/agents")).body.agents as { id: string; name: string; kind: string }[];
    // The newest one: the first, failed exchange above was also approved and is its own agent.
    const agent = listed.filter((a) => a.kind === "oauth" && a.name === "Claude").at(-1)!;
    assert.ok(agent);
    const fresh = ((await refreshed.json()) as { access_token: string }).access_token;
    const call = () => fetch(`${pub}/mcp`, { method: "POST", headers: { authorization: `Bearer ${fresh}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal((await call()).status, 200);
    await h(`/api/agents/${agent.id}`, { method: "DELETE" });
    assert.equal((await call()).status, 401, "revoking the agent cuts the connection");
  });

  test("declining sends the assistant back with access_denied", async () => {
    const clientId = await register();
    const { requestId, pairing } = await authorize(clientId);
    const queue = (await h("/api/v1/approvals")).body.approvals as { id: string; preview: string }[];
    await h(`/api/v1/approvals/${queue.find((a) => a.preview.includes(pairing))!.id}/reject`, { method: "POST" });
    const r = await poll(requestId);
    assert.equal(r.status, "denied");
    assert.equal(new URL(r.redirect!).searchParams.get("error"), "access_denied");
  });

  test("unregistered return addresses and missing PKCE are refused", async () => {
    const clientId = await register();
    const bad = await fetch(`${pub}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=x&code_challenge_method=S256`);
    assert.equal(bad.status, 400);
    const noPkce = await fetch(`${pub}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`, { redirect: "manual" });
    assert.equal(noPkce.status, 302);
    assert.equal(new URL(noPkce.headers.get("location")!).searchParams.get("error"), "invalid_request");
    const reg = await fetch(`${pub}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) });
    assert.equal(reg.status, 400);
  });
});
