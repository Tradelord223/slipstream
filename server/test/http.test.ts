import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { makeEnv } from "./helpers.ts";

describe("local mode request guards", () => {
  const env = makeEnv();
  after(() => env.cleanup());

  test("rejects unknown Host headers (DNS rebinding)", async () => {
    const r = await env.api("/api/bootstrap", { headers: { host: "attacker.test:4399" } });
    assert.equal(r.status, 421);
  });

  test("rejects API calls without the client header (cross-site forms, img tags)", async () => {
    const r = await env.api("/api/bootstrap", { headers: { "x-slipstream": "0" } });
    assert.equal(r.status, 403);
  });

  test("rejects cross-origin requests", async () => {
    const r = await env.api("/api/bootstrap", { headers: { origin: "https://attacker.test" } });
    assert.equal(r.status, 403);
  });

  test("never returns stored secrets to the browser", async () => {
    await env.api("/api/settings/ai-key", { method: "PUT", json: { apiKey: "sk-ant-test-123" } });
    const boot = await (await env.api("/api/bootstrap")).json();
    assert.equal(boot.features.ai, true);
    assert.doesNotMatch(JSON.stringify(boot), /sk-ant-test-123/);
  });

  test("rejects unknown settings keys", async () => {
    const r = await env.api("/api/settings", { method: "PUT", json: { isAdmin: true } });
    const boot = await (await env.api("/api/bootstrap")).json();
    assert.equal(r.status, 200);
    assert.equal(boot.settings.isAdmin, undefined);
  });
});

describe("team mode", () => {
  const env = makeEnv({ mode: "team" });
  after(() => env.cleanup());

  const cookieFrom = (r: Response) => r.headers.get("set-cookie")!.split(";")[0]!;

  test("first person sets up the workspace; strangers can't sign up without an invite", async () => {
    const state = await (await env.api("/api/auth/state")).json();
    assert.equal(state.needsSetup, true);
    assert.equal((await env.api("/api/bootstrap")).status, 401);

    const owner = await env.api("/api/auth/signup", {
      method: "POST",
      json: { email: "ana@team.test", name: "Ana", password: "correct horse battery", workspaceName: "Fernpoint" },
    });
    assert.equal(owner.status, 200);
    const ownerCookie = cookieFrom(owner);

    const stranger = await env.api("/api/auth/signup", {
      method: "POST",
      json: { email: "eve@evil.test", name: "Eve", password: "correct horse battery" },
    });
    assert.equal(stranger.status, 403);

    const invite = await (await env.api("/api/team/invites", { method: "POST", json: { email: "ben@team.test" }, cookie: ownerCookie })).json();
    const token = new URL(invite.url).searchParams.get("invite")!;

    const wrongEmail = await env.api("/api/auth/signup", {
      method: "POST",
      json: { email: "eve@evil.test", name: "Eve", password: "correct horse battery", invite: token },
    });
    assert.equal(wrongEmail.status, 403);

    const ben = await env.api("/api/auth/signup", {
      method: "POST",
      json: { email: "ben@team.test", name: "Ben", password: "another long password", invite: token },
    });
    assert.equal(ben.status, 200);
    const benCookie = cookieFrom(ben);

    // Invites are single use.
    const reuse = await env.api("/api/auth/signup", {
      method: "POST",
      json: { email: "ben@team.test", name: "Ben 2", password: "another long password", invite: token },
    });
    assert.notEqual(reuse.status, 200);

    const team = await (await env.api("/api/team", { cookie: benCookie })).json();
    assert.deepEqual(team.members.map((m: { name: string }) => m.name), ["Ana", "Ben"]);

    // Shared snippets show up for teammates; private ones don't.
    await env.api("/api/snippets", { method: "POST", json: { name: "Pricing", bodyHtml: "<p>Our rates…</p>", shared: true }, cookie: ownerCookie });
    await env.api("/api/snippets", { method: "POST", json: { name: "Private", bodyHtml: "<p>mine</p>" }, cookie: ownerCookie });
    const benSnippets = await (await env.api("/api/snippets", { cookie: benCookie })).json();
    assert.deepEqual(benSnippets.snippets.map((s: { name: string }) => s.name), ["Pricing"]);
    assert.equal(benSnippets.snippets[0].mine, false);
    const benEdit = await env.api(`/api/snippets/${benSnippets.snippets[0].id}`, {
      method: "PUT",
      json: { name: "Hijacked", bodyHtml: "x", shared: true },
      cookie: benCookie,
    });
    assert.equal(benEdit.status, 404);
  });

  test("wrong passwords are refused and logout ends the session", async () => {
    const bad = await env.api("/api/auth/login", { method: "POST", json: { email: "ana@team.test", password: "nope nope nope" } });
    assert.equal(bad.status, 401);
    const ok = await env.api("/api/auth/login", { method: "POST", json: { email: "ana@team.test", password: "correct horse battery" } });
    const cookie = cookieFrom(ok);
    assert.equal((await env.api("/api/bootstrap", { cookie })).status, 200);
    await env.api("/api/auth/logout", { method: "POST", cookie });
    assert.equal((await env.api("/api/bootstrap", { cookie })).status, 401);
  });
});
