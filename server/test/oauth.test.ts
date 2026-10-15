import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ProviderAuthError } from "../src/mail/types.ts";
import {
  googleAuthUrl,
  googleExchange,
  googleRedirectUri,
  microsoftAuthUrl,
  microsoftExchange,
  microsoftRedirectUri,
  OAuthSession,
} from "../src/providers/oauth.ts";
import { empty, FetchStub, json, testConfig, testCtx } from "./stub.ts";

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

describe("OAuth URLs", () => {
  it("builds the Google authorization URL with PKCE and offline access", () => {
    const config = testConfig();
    const url = new URL(googleAuthUrl(config, "st4te", "chal"));
    assert.equal(`${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("client_id"), "g-client");
    assert.equal(p.get("redirect_uri"), googleRedirectUri(config));
    assert.equal(p.get("redirect_uri"), "http://127.0.0.1:4380/api/oauth/google/callback");
    assert.equal(p.get("scope"), "openid email profile https://www.googleapis.com/auth/gmail.modify");
    assert.equal(p.get("access_type"), "offline");
    assert.equal(p.get("prompt"), "consent");
    assert.equal(p.get("include_granted_scopes"), "true");
    assert.equal(p.get("state"), "st4te");
    assert.equal(p.get("code_challenge"), "chal");
    assert.equal(p.get("code_challenge_method"), "S256");
  });

  it("builds the Microsoft authorization URL for the configured tenant", () => {
    const config = testConfig({ microsoft: { clientId: "m-client", tenant: "contoso.onmicrosoft.com" } });
    const url = new URL(microsoftAuthUrl(config, "st4te", "chal"));
    assert.equal(`${url.origin}${url.pathname}`, "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
    const p = url.searchParams;
    assert.equal(p.get("client_id"), "m-client");
    assert.equal(p.get("redirect_uri"), "http://localhost:4380/api/oauth/microsoft/callback");
    assert.equal(p.get("scope"), "offline_access openid profile email User.Read Mail.ReadWrite Mail.Send");
    assert.equal(p.get("code_challenge"), "chal");
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.equal(p.get("response_type"), "code");
  });

  it("uses the public URL for Microsoft redirects in team mode", () => {
    const config = testConfig({ mode: "team", publicUrl: "https://mail.example.com" });
    assert.equal(microsoftRedirectUri(config), "https://mail.example.com/api/oauth/microsoft/callback");
    assert.equal(googleRedirectUri(config), "https://mail.example.com/api/oauth/google/callback");
  });
});

describe("code exchange", () => {
  it("exchanges a Google code and reads the identity", async () => {
    stub = new FetchStub()
      .on("POST", "https://oauth2.googleapis.com/token", { access_token: "at", refresh_token: "rt", expires_in: 3599 })
      .on("GET", "https://openidconnect.googleapis.com/v1/userinfo", { email: "me@gmail.com", name: "Me Myself" });
    const before = Date.now();
    const result = await googleExchange(testConfig(), "the-code", "the-verifier");
    assert.equal(result.email, "me@gmail.com");
    assert.equal(result.name, "Me Myself");
    const auth = result.auth as { accessToken: string; refreshToken: string; expiresAt: number };
    assert.equal(auth.accessToken, "at");
    assert.equal(auth.refreshToken, "rt");
    assert.ok(auth.expiresAt >= before + 3_599_000 && auth.expiresAt <= Date.now() + 3_599_000);

    const form = new URLSearchParams(stub.callsTo("POST", "https://oauth2.googleapis.com/token")[0]!.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "the-code");
    assert.equal(form.get("code_verifier"), "the-verifier");
    assert.equal(form.get("client_id"), "g-client");
    assert.equal(form.get("client_secret"), "g-secret");
    assert.equal(form.get("redirect_uri"), "http://127.0.0.1:4380/api/oauth/google/callback");
    assert.equal(stub.callsTo("GET", "https://openidconnect.googleapis.com/v1/userinfo")[0]!.headers.get("authorization"), "Bearer at");
  });

  it("leaves client_secret out when none is configured", async () => {
    stub = new FetchStub()
      .on("POST", "https://login.microsoftonline.com/common/oauth2/v2.0/token", { access_token: "at", refresh_token: "rt", expires_in: 3600 })
      .on("GET", "https://graph.microsoft.com/v1.0/me", { mail: null, userPrincipalName: "me@contoso.com", displayName: "Me" });
    const result = await microsoftExchange(testConfig(), "c", "v");
    assert.equal(result.email, "me@contoso.com");
    assert.equal(result.name, "Me");
    const form = new URLSearchParams(stub.calls[0]!.body);
    assert.equal(form.has("client_secret"), false);
    assert.equal(form.get("code_verifier"), "v");
    assert.equal(form.get("redirect_uri"), "http://localhost:4380/api/oauth/microsoft/callback");
  });

  it("prefers the mailbox address over the principal name", async () => {
    stub = new FetchStub()
      .on("POST", /\/oauth2\/v2\.0\/token$/, { access_token: "at", refresh_token: "rt", expires_in: 3600 })
      .on("GET", "https://graph.microsoft.com/v1.0/me", { mail: "me@contoso.com", userPrincipalName: "me@contoso.onmicrosoft.com", displayName: "" });
    const result = await microsoftExchange(testConfig({ microsoft: { clientId: "m", clientSecret: "s", tenant: "contoso" } }), "c", "v");
    assert.equal(result.email, "me@contoso.com");
    assert.equal(result.name, "me@contoso.com");
    assert.equal(new URLSearchParams(stub.calls[0]!.body).get("client_secret"), "s");
    assert.match(stub.calls[0]!.url.href, /\/contoso\/oauth2/);
  });

  it("reports the provider's error when the code is rejected", async () => {
    stub = new FetchStub().on("POST", "https://oauth2.googleapis.com/token", json({ error: "invalid_grant", error_description: "Bad Request" }, 400));
    await assert.rejects(googleExchange(testConfig(), "c", "v"), /invalid_grant/);
  });

  it("fails clearly when Google returns no refresh token", async () => {
    stub = new FetchStub().on("POST", "https://oauth2.googleapis.com/token", { access_token: "at", expires_in: 3600 });
    await assert.rejects(googleExchange(testConfig(), "c", "v"), /refresh token/);
  });
});

describe("OAuthSession", () => {
  const api = "https://api.example.com/thing";

  it("refreshes shortly before expiry and saves the new tokens, keeping the old refresh token", async () => {
    stub = new FetchStub()
      .on("POST", "https://oauth2.googleapis.com/token", { access_token: "tok-2", expires_in: 3600 })
      .on("GET", api, empty(200));
    const ctx = testCtx({ auth: { accessToken: "tok-1", refreshToken: "ref-1", expiresAt: Date.now() + 30_000 } });
    const session = new OAuthSession("google", ctx, testConfig());
    await session.fetch(api);
    assert.equal(stub.callsTo("GET", api)[0]!.headers.get("authorization"), "Bearer tok-2");
    const refresh = new URLSearchParams(stub.callsTo("POST", "https://oauth2.googleapis.com/token")[0]!.body);
    assert.equal(refresh.get("grant_type"), "refresh_token");
    assert.equal(refresh.get("refresh_token"), "ref-1");
    assert.equal(ctx.saved.length, 1);
    const saved = ctx.saved[0] as { accessToken: string; refreshToken: string; expiresAt: number };
    assert.equal(saved.accessToken, "tok-2");
    assert.equal(saved.refreshToken, "ref-1");
    assert.ok(saved.expiresAt > Date.now() + 3_000_000);
  });

  it("does not refresh a token that is still good", async () => {
    stub = new FetchStub().on("GET", api, empty(200));
    const ctx = testCtx();
    await new OAuthSession("google", ctx, testConfig()).fetch(api);
    assert.equal(ctx.saved.length, 0);
    assert.equal(stub.calls.length, 1);
  });

  it("refreshes once on a 401 and retries", async () => {
    let n = 0;
    stub = new FetchStub()
      .on("POST", "https://oauth2.googleapis.com/token", { access_token: "tok-2", refresh_token: "ref-2", expires_in: 3600 })
      .on("GET", api, (call) => (call.headers.get("authorization") === "Bearer tok-1" ? (n++, empty(401)) : empty(200)));
    const ctx = testCtx();
    const res = await new OAuthSession("google", ctx, testConfig()).fetch(api);
    assert.equal(res.status, 200);
    assert.equal(n, 1);
    assert.equal((ctx.saved[0] as { refreshToken: string }).refreshToken, "ref-2");
  });

  it("throws ProviderAuthError when the retry is also a 401", async () => {
    stub = new FetchStub().on("POST", "https://oauth2.googleapis.com/token", { access_token: "tok-2", expires_in: 3600 }).on("GET", api, empty(401));
    await assert.rejects(new OAuthSession("google", testCtx(), testConfig()).fetch(api), ProviderAuthError);
    assert.equal(stub.callsTo("POST", "https://oauth2.googleapis.com/token").length, 1);
  });

  it("shares one refresh between concurrent requests", async () => {
    stub = new FetchStub()
      .on("POST", "https://oauth2.googleapis.com/token", () => json({ access_token: "tok-2", expires_in: 3600 }))
      .on("GET", api, (call) => (call.headers.get("authorization") === "Bearer tok-2" ? empty(200) : empty(401)));
    const session = new OAuthSession("google", testCtx(), testConfig());
    const results = await Promise.all([session.fetch(api), session.fetch(api), session.fetch(api)]);
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.equal(stub.callsTo("POST", "https://oauth2.googleapis.com/token").length, 1);
  });

  it("throws ProviderAuthError when the refresh token is revoked", async () => {
    stub = new FetchStub().on("POST", "https://oauth2.googleapis.com/token", json({ error: "invalid_grant" }, 400));
    const ctx = testCtx({ auth: { accessToken: "old", refreshToken: "ref-1", expiresAt: 0 } });
    await assert.rejects(new OAuthSession("google", ctx, testConfig()).fetch(api), ProviderAuthError);
    assert.equal(ctx.saved.length, 0);
  });

  it("treats a server error during refresh as retryable, not as a lost sign-in", async () => {
    stub = new FetchStub().on("POST", "https://oauth2.googleapis.com/token", json({ error: "backend_error" }, 503));
    const ctx = testCtx({ auth: { accessToken: "old", refreshToken: "ref-1", expiresAt: 0 } });
    await assert.rejects(new OAuthSession("google", ctx, testConfig()).fetch(api), (err: Error) => !(err instanceof ProviderAuthError));
  });

  it("refreshes Microsoft tokens at the tenant endpoint", async () => {
    stub = new FetchStub()
      .on("POST", "https://login.microsoftonline.com/contoso/oauth2/v2.0/token", { access_token: "tok-2", refresh_token: "ref-2", expires_in: 3600 })
      .on("GET", api, empty(200));
    const ctx = testCtx({ auth: { accessToken: "old", refreshToken: "ref-1", expiresAt: 0 } });
    await new OAuthSession("microsoft", ctx, testConfig({ microsoft: { clientId: "m", tenant: "contoso" } })).fetch(api);
    const form = new URLSearchParams(stub.calls[0]!.body);
    assert.equal(form.get("client_id"), "m");
    assert.equal(form.has("client_secret"), false);
    assert.equal((ctx.saved[0] as { refreshToken: string }).refreshToken, "ref-2");
  });

  it("asks for a new sign-in when the account has no credentials", async () => {
    stub = new FetchStub();
    await assert.rejects(new OAuthSession("google", testCtx({ auth: null }), testConfig()).fetch(api), ProviderAuthError);
  });
});
