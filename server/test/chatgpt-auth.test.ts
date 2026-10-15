import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ChatGPTAuth } from "../src/agents/engines/chatgpt-auth.ts";
import { EngineAccounts } from "../src/agents/engines/accounts.ts";
import { EngineError } from "../src/agents/engines/loop.ts";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const U = LOCAL_USER_ID;
const CLIENT = "oaiapp_test123";

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

interface Hit {
  path: string;
  form: Record<string, string>;
}

/** A stand-in for auth.openai.com: records every request and answers the token endpoint. */
class FakeAuth {
  server: Server;
  hits: Hit[] = [];
  /** Filled in from the authorize URL the app built, as the real server would remember it. */
  nonce = "";
  challenge = "";
  tokenResponse: (form: Record<string, string>) => { status: number; body: unknown } = (form) =>
    form.grant_type === "refresh_token" ? this.refreshReply(`access-${this.hits.length}`, `refresh-${this.hits.length}`) : this.codeReply();
  refreshDelay = 0;
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => {
        const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
        const path = req.url ?? "";
        this.hits.push({ path, form });
        const reply = path.endsWith("/token") ? this.tokenResponse(form) : { status: 200, body: "" };
        const send = () => {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
        };
        if (form.grant_type === "refresh_token" && this.refreshDelay) setTimeout(send, this.refreshDelay);
        else send();
      });
    });
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }

  idToken(over: Record<string, unknown> = {}) {
    return jwt({
      iss: this.url,
      aud: CLIENT,
      nonce: this.nonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "user-sub",
      email: "me@example.test",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      ...over,
    });
  }

  codeReply() {
    return {
      status: 200,
      body: {
        access_token: "access-first",
        refresh_token: "refresh-first",
        id_token: this.idToken(),
        expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      },
    };
  }

  refreshReply(access: string, refresh: string) {
    return { status: 200, body: { access_token: access, refresh_token: refresh, expires_in: 3600 } };
  }

  tokenHits() {
    return this.hits.filter((h) => h.path.endsWith("/token"));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const portOpen = (port: number) =>
  fetch(`http://127.0.0.1:${port}/auth/callback`, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );

describe("ChatGPT sign-in", () => {
  let env: TestEnv;
  let fake: FakeAuth;
  let accounts: EngineAccounts;
  let auth: ChatGPTAuth;
  let port: number;

  beforeEach(async () => {
    env = makeEnv();
    fake = new FakeAuth();
    await fake.start();
    port = await freePort();
    process.env.SLIPSTREAM_OPENAI_AUTH_URL = fake.url;
    process.env.SLIPSTREAM_CHATGPT_CALLBACK_PORT = String(port);
    accounts = new EngineAccounts(env.ctx);
    auth = new ChatGPTAuth(env.ctx, accounts);
  });

  afterEach(() => {
    auth.close();
    fake.stop();
    env.cleanup();
    delete process.env.SLIPSTREAM_OPENAI_AUTH_URL;
    delete process.env.SLIPSTREAM_CHATGPT_CALLBACK_PORT;
  });

  /** What the browser does after the person approves: follow the redirect back with a code. */
  function approve(authorizeUrl: string, over: Record<string, string> = {}) {
    const u = new URL(authorizeUrl);
    fake.nonce = u.searchParams.get("nonce")!;
    fake.challenge = u.searchParams.get("code_challenge")!;
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", u.searchParams.get("state")!);
    back.searchParams.set("scope", "openid chatgpt.tokens.use.direct");
    back.searchParams.set("client_id", CLIENT);
    for (const [k, v] of Object.entries(over)) back.searchParams.set(k, v);
    return back;
  }

  async function signIn() {
    const { authorizeUrl } = await auth.begin(U);
    const res = await fetch(approve(authorizeUrl));
    assert.equal(res.status, 200);
  }

  it("builds the authorize URL for a first registration", async () => {
    const { authorizeUrl, mode } = await auth.begin(U);
    assert.equal(mode, "loopback");
    const u = new URL(authorizeUrl);
    assert.equal(`${u.origin}${u.pathname}`, `${fake.url}/api/accounts/authorize`);
    const p = u.searchParams;
    assert.equal(p.get("client_id"), "dynamic_agent_client");
    assert.equal(p.get("agent_name_hint"), "Slipstream");
    assert.ok(p.get("ext_agent_host_id"));
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("redirect_uri"), `http://127.0.0.1:${port}/auth/callback`);
    assert.equal(p.get("resource"), "https://api.openai.com/v1");
    assert.equal(p.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.ok(p.get("state") && p.get("nonce") && p.get("code_challenge"));
    // The host id is stable across sign-ins.
    const again = new URL((await auth.begin(U)).authorizeUrl);
    assert.equal(again.searchParams.get("ext_agent_host_id"), p.get("ext_agent_host_id"));
  });

  it("completes the loopback flow and stores sealed tokens", async () => {
    const { authorizeUrl, mode } = await auth.begin(U);
    assert.equal(mode, "loopback");
    assert.equal(auth.status(U).pending, true);
    const res = await fetch(approve(authorizeUrl));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /You(&#39;|')re signed in to ChatGPT\. You can close this tab and return to Slipstream\./);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/);

    const [hit] = fake.tokenHits();
    assert.equal(hit!.form.grant_type, "authorization_code");
    assert.equal(hit!.form.client_id, CLIENT);
    assert.equal(hit!.form.code, "the-code");
    assert.equal(hit!.form.redirect_uri, `http://127.0.0.1:${port}/auth/callback`);
    assert.equal(hit!.form.resource, "https://api.openai.com/v1");
    assert.equal(createHash("sha256").update(hit!.form.code_verifier!).digest("base64url"), fake.challenge);
    assert.equal(hit!.form.client_secret, undefined);

    const stored = accounts.secret<Record<string, unknown>>(U, "chatgpt")!;
    assert.equal(stored.clientId, CLIENT);
    assert.equal(stored.accessToken, "access-first");
    assert.equal(stored.refreshToken, "refresh-first");
    assert.equal(stored.email, "me@example.test");
    assert.equal(stored.plan, "plus");
    // Sealed at rest, not plaintext.
    const raw = env.ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = 'secret:chatgpt'", U)!.value;
    assert.doesNotMatch(raw, /access-first|refresh-first/);

    assert.deepEqual(auth.status(U), { signedIn: true, email: "me@example.test", plan: "plus", pending: false });
    assert.equal(await auth.accessToken(U), "access-first");

    // The next sign-in reuses the issued client id instead of registering again.
    const next = new URL((await auth.begin(U)).authorizeUrl);
    assert.equal(next.searchParams.get("client_id"), CLIENT);
    assert.equal(next.searchParams.get("agent_name_hint"), null);
  });

  it("closes the listener after success and answers only GET /auth/callback", async () => {
    const { authorizeUrl } = await auth.begin(U);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/callback`, { method: "POST" })).status, 404);
    assert.equal(await portOpen(port), true);
    await fetch(approve(authorizeUrl));
    assert.equal(await portOpen(port), false);
  });

  it("falls back to paste mode when the port is busy, then completes from the pasted address", async () => {
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      const { authorizeUrl, mode } = await auth.begin(U);
      assert.equal(mode, "paste");
      const pasted = approve(authorizeUrl).toString();
      await auth.complete(U, `  ${pasted}  `);
      assert.equal(auth.status(U).signedIn, true);
      assert.equal(fake.tokenHits()[0]!.form.redirect_uri, `http://127.0.0.1:${port}/auth/callback`);
      // Spent: pasting the same address again fails.
      await assert.rejects(() => auth.complete(U, pasted), /expired/);
    } finally {
      squatter.close();
    }
  });

  it("uses paste mode on a team server without opening a listener", async () => {
    const teamEnv = makeEnv({ mode: "team" });
    teamEnv.ctx.users.ensureLocalUser();
    const team = new ChatGPTAuth(teamEnv.ctx, new EngineAccounts(teamEnv.ctx));
    try {
      const { mode } = await team.begin(U);
      assert.equal(mode, "paste");
      assert.equal(await portOpen(port), false);
    } finally {
      team.close();
      teamEnv.cleanup();
    }
  });

  it("rejects a wrong state without spending the real one", async () => {
    const { authorizeUrl } = await auth.begin(U);
    const bad = await fetch(approve(authorizeUrl, { state: "forged" }));
    assert.equal(bad.status, 400);
    assert.equal(fake.tokenHits().length, 0);
    assert.equal(auth.status(U).signedIn, false);
    assert.equal(auth.status(U).pending, true);
    // The genuine callback still works afterwards.
    assert.equal((await fetch(approve(authorizeUrl))).status, 200);
    assert.equal(auth.status(U).signedIn, true);
  });

  it("rejects a wrong state in paste mode and an expired one", async (t) => {
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      const { authorizeUrl, mode } = await auth.begin(U);
      assert.equal(mode, "paste");
      await assert.rejects(() => auth.complete(U, approve(authorizeUrl, { state: "forged" }).toString()), /different sign-in/);
      assert.equal(fake.tokenHits().length, 0);

      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      t.mock.timers.tick(10 * 60 * 1000 + 1000);
      await assert.rejects(() => auth.complete(U, approve(authorizeUrl).toString()), /expired/);
      assert.equal(fake.tokenHits().length, 0);
      assert.equal(auth.status(U).pending, false);
    } finally {
      squatter.close();
    }
  });

  it("records an access_denied callback for status", async () => {
    const { authorizeUrl } = await auth.begin(U);
    const u = approve(authorizeUrl, { error: "access_denied" });
    u.searchParams.delete("code");
    const res = await fetch(u);
    assert.equal(res.status, 400);
    assert.equal(fake.tokenHits().length, 0);
    const s = auth.status(U);
    assert.equal(s.signedIn, false);
    assert.equal(s.pending, false);
    assert.match(s.lastError!, /cancelled|isn't enabled/);
    assert.equal(await portOpen(port), false);
  });

  it("refuses a sign-in whose grant lacks plan use", async () => {
    fake.tokenResponse = () => ({ status: 200, body: { ...(fake.codeReply().body as object), scope: "openid profile" } });
    const { authorizeUrl } = await auth.begin(U);
    const res = await fetch(approve(authorizeUrl, { scope: "openid" }));
    assert.equal(res.status, 400);
    assert.equal(auth.status(U).signedIn, false);
    assert.match(auth.status(U).lastError!, /plan use/);
  });

  it("refuses an id_token with the wrong nonce, audience or issuer", async () => {
    for (const bad of [{ nonce: "other" }, { aud: "oaiapp_other" }, { iss: "https://evil.example" }]) {
      fake.tokenResponse = () => ({ status: 200, body: { ...(fake.codeReply().body as object), id_token: fake.idToken(bad) } });
      const { authorizeUrl } = await auth.begin(U);
      assert.equal((await fetch(approve(authorizeUrl))).status, 400);
      assert.equal(auth.status(U).signedIn, false);
    }
  });

  describe("tokens", () => {
    beforeEach(signIn);

    function age(ms: number) {
      const s = accounts.secret<Record<string, unknown>>(U, "chatgpt")!;
      accounts.setSecret(U, "chatgpt", { ...s, expiresAt: Date.now() + ms });
    }

    it("does not refresh while the token has more than five minutes left", async () => {
      assert.equal(await auth.accessToken(U), "access-first");
      assert.equal(fake.tokenHits().length, 1);
    });

    it("shares one refresh between concurrent callers and saves the rotated refresh token", async () => {
      age(60_000);
      fake.refreshDelay = 50;
      const [a, b, c] = await Promise.all([auth.accessToken(U), auth.accessToken(U), auth.accessToken(U)]);
      const refreshes = fake.tokenHits().filter((h) => h.form.grant_type === "refresh_token");
      assert.equal(refreshes.length, 1);
      assert.equal(refreshes[0]!.form.refresh_token, "refresh-first");
      assert.equal(refreshes[0]!.form.client_id, CLIENT);
      assert.equal(refreshes[0]!.form.resource, "https://api.openai.com/v1");
      assert.equal(refreshes[0]!.form.scope, undefined);
      assert.equal(a, b);
      assert.equal(b, c);
      const stored = accounts.secret<{ accessToken: string; refreshToken: string; expiresAt: number; email: string }>(U, "chatgpt")!;
      assert.equal(stored.accessToken, a);
      assert.notEqual(stored.refreshToken, "refresh-first");
      assert.ok(stored.expiresAt > Date.now() + 50 * 60 * 1000);
      assert.equal(stored.email, "me@example.test");

      // The next refresh presents the rotated token.
      age(60_000);
      await auth.accessToken(U);
      const last = fake.tokenHits().at(-1)!;
      assert.equal(last.form.refresh_token, stored.refreshToken);
    });

    it("refreshNow refreshes once after a 401, and not again for a token already replaced", async () => {
      fake.refreshDelay = 20;
      const [a, b] = await Promise.all([auth.refreshNow(U, "access-first"), auth.refreshNow(U, "access-first")]);
      assert.equal(a, b);
      assert.notEqual(a, "access-first");
      assert.equal(fake.tokenHits().filter((h) => h.form.grant_type === "refresh_token").length, 1);
      assert.equal(await auth.refreshNow(U, "access-first"), a);
      assert.equal(fake.tokenHits().filter((h) => h.form.grant_type === "refresh_token").length, 1);
    });

    it("signs out and throws an auth error on invalid_grant", async () => {
      age(60_000);
      fake.tokenResponse = () => ({ status: 400, body: { error: "invalid_grant" } });
      await assert.rejects(
        () => auth.accessToken(U),
        (err) => err instanceof EngineError && err.kind === "auth" && err.message === "Sign in to ChatGPT again.",
      );
      assert.equal(accounts.secret(U, "chatgpt"), null);
      const s = auth.status(U);
      assert.equal(s.signedIn, false);
      assert.equal(s.lastError, "Sign in to ChatGPT again.");
    });

    it("forgets a dead client registration so the next sign-in registers again", async () => {
      age(60_000);
      fake.tokenResponse = () => ({ status: 401, body: { error: "invalid_client" } });
      await assert.rejects(() => auth.accessToken(U), (err) => err instanceof EngineError && err.kind === "auth");
      const next = new URL((await auth.begin(U)).authorizeUrl);
      assert.equal(next.searchParams.get("client_id"), "dynamic_agent_client");
    });

    it("sign-out during a refresh revokes the rotated refresh token", async () => {
      age(60_000);
      fake.refreshDelay = 50;
      const refreshing = auth.accessToken(U);
      const out = auth.signOut(U);
      await Promise.all([refreshing, out]);
      const rotated = fake.hits.find((h) => h.form.grant_type === "refresh_token");
      assert.ok(rotated);
      const revoke = fake.hits.find((h) => h.path.endsWith("/revoke"))!;
      assert.match(revoke.form.token!, /^refresh-\d+$/);
      assert.notEqual(revoke.form.token, "refresh-first");
      assert.equal(accounts.secret(U, "chatgpt"), null);
    });

    it("serves the current token if a refresh fails but it hasn't expired", async () => {
      age(4 * 60_000);
      fake.tokenResponse = () => ({ status: 503, body: "busy" });
      assert.equal(await auth.accessToken(U), "access-first");
    });

    it("keeps the sign-in when the refresh fails for a passing reason", async () => {
      age(10_000);
      fake.tokenResponse = () => ({ status: 503, body: "busy" });
      await assert.rejects(
        () => auth.accessToken(U),
        (err) => err instanceof EngineError && err.kind === "unavailable",
      );
      assert.equal(auth.status(U).signedIn, true);
    });

    it("status never contains tokens", async () => {
      const text = JSON.stringify(auth.status(U));
      for (const secret of ["access-first", "refresh-first", CLIENT, "user-sub"]) assert.ok(!text.includes(secret), secret);
      assert.deepEqual(Object.keys(auth.status(U)).sort(), ["email", "pending", "plan", "signedIn"]);
    });

    it("signs out: clears the tokens and revokes the refresh token", async () => {
      assert.deepEqual(await auth.signOut(U), { revoked: true });
      assert.equal(accounts.secret(U, "chatgpt"), null);
      assert.equal(auth.status(U).signedIn, false);
      const revoke = fake.hits.find((h) => h.path.endsWith("/revoke"))!;
      assert.equal(revoke.form.token, "refresh-first");
      assert.equal(revoke.form.token_type_hint, "refresh_token");
      assert.equal(revoke.form.client_id, CLIENT);
      await assert.rejects(() => auth.accessToken(U), (err) => err instanceof EngineError && err.kind === "auth");
    });
  });
});
