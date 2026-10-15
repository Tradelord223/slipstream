import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AppContext } from "../../context.ts";
import { randomToken } from "../../lib/crypto.ts";
import { escapeHtml } from "../../lib/text.ts";
import type { EngineAccounts } from "./accounts.ts";
import { EngineError } from "./loop.ts";

/**
 * Sign in with ChatGPT, through OpenAI's open-source "token sharing" flow
 * (https://developers.openai.com/siwc/token-sharing-open-source/sign-in): the person signs in with their
 * ChatGPT plan and agents run on it. Public client, PKCE, no client secret.
 *
 * The redirect is a loopback address, so the browser must be on the same machine as Slipstream. Local
 * installs listen on 127.0.0.1 for the length of one sign-in. Everywhere else (a busy port, a team
 * server) the browser lands on a page that fails to load, and the person pastes its address back.
 */

const REGISTER_CLIENT = "dynamic_agent_client";
const APP_NAME = "Slipstream";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const CALLBACK_PATH = "/auth/callback";
const PENDING_TTL = 10 * 60 * 1000;
const REFRESH_WINDOW = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 15_000;
const SIGN_IN_AGAIN = "Sign in to ChatGPT again.";
/** Token-endpoint errors that mean the refresh token is dead, not that the network hiccuped. */
const DEAD_GRANT = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_token",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

interface Stored {
  /** The issued oaiapp_… client id these tokens belong to. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** The OpenID subject: the account's stable identity (email isn't one). */
  sub?: string;
  /** For display only. */
  email?: string;
  plan?: string;
}

interface Pending {
  userId: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The client id for a returning sign-in; absent on first registration. */
  clientId: string | null;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface ChatGPTStatus {
  signedIn: boolean;
  email?: string;
  plan?: string;
  pending: boolean;
  lastError?: string;
}

/** Constant-time string comparison that tolerates different lengths. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The payload of a JWT. The signature isn't checked against the JWKS: the token arrives straight from the
 * issuer's token endpoint over TLS, which OIDC Core 3.1.3.7 accepts, and nothing here trusts it beyond display.
 */
function jwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const payload = jwt.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function resultPage(ok: boolean, message: string): string {
  const title = ok ? "Signed in" : "Couldn't sign in";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Slipstream</title><style>
:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;background:#0B0D12;color:#E7EAF0}
@media (prefers-color-scheme:light){body{background:#F6F7F9;color:#12151C}}main{max-width:420px;margin:16px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{margin:0}
</style></head><body><main><h1>${title}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

export class ChatGPTAuth {
  private ctx: AppContext;
  private accounts: EngineAccounts;
  private pending = new Map<string, Pending>();
  private errors = new Map<string, string>();
  private refreshing = new Map<string, Promise<string>>();
  private server: Server | null = null;
  private serverTimer: NodeJS.Timeout | null = null;

  constructor(ctx: AppContext, accounts: EngineAccounts) {
    this.ctx = ctx;
    this.accounts = accounts;
  }

  private authUrl(): string {
    return (process.env.SLIPSTREAM_OPENAI_AUTH_URL || "https://auth.openai.com").replace(/\/$/, "");
  }

  private callbackPort(): number {
    const raw = process.env.SLIPSTREAM_CHATGPT_CALLBACK_PORT;
    const n = raw ? Number(raw) : 1455;
    return Number.isInteger(n) && n >= 0 && n < 65536 ? n : 1455;
  }

  // ---- Small per-user settings (not secret: a random host id and a public client id) ----------

  private getSetting(userId: string, key: string): string | null {
    return this.ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = ?", userId, key)?.value ?? null;
  }

  private setSetting(userId: string, key: string, value: string) {
    this.ctx.db.run(
      "INSERT INTO settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
      userId,
      key,
      value,
    );
  }

  /** A stable random id for this installation and person, created on first sign-in. */
  private hostId(userId: string): string {
    let id = this.getSetting(userId, "chatgpt:host");
    if (!id) {
      id = `slipstream-${randomToken(16)}`;
      this.setSetting(userId, "chatgpt:host", id);
    }
    return id;
  }

  private forgetClient(userId: string) {
    this.ctx.db.run("DELETE FROM settings WHERE user_id = ? AND key = 'chatgpt:client'", userId);
  }

  private stored(userId: string): Stored | null {
    return this.accounts.secret<Stored>(userId, "chatgpt");
  }

  // ---- Sign-in ------------------------------------------------------------------------------

  async begin(userId: string): Promise<{ authorizeUrl: string; mode: "loopback" | "paste" }> {
    this.endPending(userId);
    this.errors.delete(userId);
    const port = this.callbackPort();
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const verifier = randomToken(48);
    const p: Pending = {
      userId,
      state: randomToken(32),
      nonce: randomToken(16),
      verifier,
      redirectUri,
      // A returning sign-in reuses the client id issued the first time; a client registered once stays registered.
      clientId: this.getSetting(userId, "chatgpt:client"),
      expiresAt: Date.now() + PENDING_TTL,
    };

    // Local installs are the only place a loopback listener can be reached by the person's browser.
    this.pending.set(userId, p);
    let mode: "loopback" | "paste" = "paste";
    if (this.ctx.config.mode === "local") {
      this.closeServer();
      if (await this.listen(p, port)) mode = "loopback";
    }

    const q = new URLSearchParams({
      client_id: p.clientId ?? REGISTER_CLIENT,
      ext_agent_host_id: this.hostId(userId),
      response_type: "code",
      redirect_uri: p.redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state: p.state,
      nonce: p.nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    if (!p.clientId) q.set("agent_name_hint", APP_NAME);
    return { authorizeUrl: `${this.authUrl()}/api/accounts/authorize?${q}`, mode };
  }

  /** Paste mode: the person copies the address their browser ended up on and hands it to us. */
  async complete(userId: string, pastedUrl: string): Promise<void> {
    const p = this.pending.get(userId);
    if (!p || p.expiresAt < Date.now()) {
      this.endPending(userId);
      throw new EngineError("bad_request", "That sign-in expired. Start again.");
    }
    let url: URL;
    try {
      url = new URL(pastedUrl.trim());
    } catch {
      throw new EngineError("bad_request", "Paste the whole address from your browser's address bar.");
    }
    if (url.pathname !== CALLBACK_PATH) throw new EngineError("bad_request", "That isn't the sign-in address. Copy it from the page that failed to load.");
    const state = url.searchParams.get("state");
    if (!state || !safeEqual(state, p.state)) throw new EngineError("bad_request", "That address belongs to a different sign-in. Start again.");
    try {
      await this.finish(p, url.searchParams);
    } finally {
      if (this.pending.size === 0) this.closeServer();
    }
  }

  /** Both modes land here once the state has matched. The state is spent whatever happens next. */
  private async finish(p: Pending, params: URLSearchParams): Promise<void> {
    // The state is single use: spent here, before anything can fail.
    this.pending.delete(p.userId);
    try {
      const error = params.get("error");
      if (error === "access_denied") throw new EngineError("auth", "ChatGPT sign-in was cancelled, or ChatGPT plan use isn't enabled for this account.");
      if (error) throw new EngineError("auth", `ChatGPT sign-in failed (${error}).`);
      const code = params.get("code");
      if (!code) throw new EngineError("bad_request", "ChatGPT didn't send a sign-in code. Start again.");
      const clientId = p.clientId ?? params.get("client_id");
      if (!clientId || (!p.clientId && !clientId.startsWith("oaiapp_")))
        throw new EngineError("auth", "ChatGPT didn't finish registering Slipstream. Start again.");

      const t = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: p.verifier,
        redirect_uri: p.redirectUri,
        resource: RESOURCE,
      });
      if (!t.ok) {
        if (t.error === "invalid_client" || t.error === "unauthorized_client") this.forgetClient(p.userId);
        if (t.error === "invalid_grant") throw new EngineError("auth", "That sign-in expired. Start again.");
        throw new EngineError("unavailable", "ChatGPT sign-in didn't complete. Try again.");
      }
      const body = t.body;
      if (!body.access_token || !body.refresh_token || !body.id_token) throw new EngineError("auth", "ChatGPT's reply was incomplete. Start again.");

      const scopes = (body.scope ?? params.get("scope") ?? "").split(/\s+/);
      if (!scopes.includes(REQUIRED_SCOPE)) throw new EngineError("auth", "ChatGPT plan use isn't enabled for this account.");

      const claims = jwtClaims(body.id_token);
      const aud = claims?.aud;
      const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
      const issOk = str(claims?.iss) === this.authUrl();
      const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : 0;
      if (!claims || !audOk || !issOk || exp < Date.now() || !safeEqual(str(claims.nonce) ?? "", p.nonce))
        throw new EngineError("auth", "ChatGPT's identity check failed. Start again.");
      const auth = claims["https://api.openai.com/auth"];
      const plan = auth && typeof auth === "object" ? str((auth as Record<string, unknown>).chatgpt_plan_type) : undefined;

      const value: Stored = {
        clientId,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        sub: str(claims.sub),
        email: str(claims.email),
        plan,
      };
      this.accounts.setSecret(p.userId, "chatgpt", value);
      this.setSetting(p.userId, "chatgpt:client", clientId);
      this.errors.delete(p.userId);
    } catch (err) {
      this.errors.set(p.userId, err instanceof Error ? err.message : "ChatGPT sign-in failed.");
      throw err;
    }
  }

  // ---- Loopback listener --------------------------------------------------------------------

  /** Open the callback listener. False if the port is taken (or can't be bound): the caller falls back to paste. */
  private listen(p: Pending, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        void this.onRequest(p, server, req.method, req.url ?? "", res);
      });
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        server.on("error", () => {});
        // The port may have been 0 in tests; the redirect has to carry the real one.
        const addr = server.address();
        if (addr && typeof addr === "object") p.redirectUri = `http://127.0.0.1:${addr.port}${CALLBACK_PATH}`;
        this.server = server;
        this.serverTimer = setTimeout(() => this.endPending(p.userId), PENDING_TTL);
        this.serverTimer.unref();
        resolve(true);
      });
    });
  }

  private async onRequest(p: Pending, server: Server, method: string | undefined, rawUrl: string, res: ServerResponse) {
    const send = (status: number, ok: boolean, message: string, last = false) => {
      if (last) res.once("finish", () => this.server === server && this.closeServer());
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
        connection: "close",
      });
      res.end(resultPage(ok, message));
    };
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { connection: "close" }).end();
      return;
    }
    const live = this.pending.get(p.userId) === p && p.expiresAt >= Date.now();
    const state = url.searchParams.get("state");
    if (!live || !state || !safeEqual(state, p.state)) {
      // Not our flow (a stale tab, or something probing the port): say so and leave the real sign-in alone.
      send(400, false, "This sign-in link isn't valid or has expired. Start again from Slipstream.");
      return;
    }
    try {
      await this.finish(p, url.searchParams);
      send(200, true, "You're signed in to ChatGPT. You can close this tab and return to Slipstream.", true);
    } catch (err) {
      send(400, false, err instanceof Error ? err.message : "Something went wrong. Start again from Slipstream.", true);
    }
  }

  private closeServer() {
    if (this.serverTimer) clearTimeout(this.serverTimer);
    this.serverTimer = null;
    const s = this.server;
    this.server = null;
    s?.close();
    s?.closeAllConnections();
  }

  /** Forget a user's in-progress sign-in and shut the listener if it was theirs. */
  private endPending(userId: string) {
    this.pending.delete(userId);
    if (this.server && this.pending.size === 0) this.closeServer();
  }

  close() {
    this.pending.clear();
    this.closeServer();
  }

  // ---- Tokens -------------------------------------------------------------------------------

  /** A form-encoded POST to the token endpoint. Network failures and 5xx throw; 4xx come back as an error code. */
  private async tokenRequest(form: Record<string, string>): Promise<{ ok: true; body: TokenResponse } | { ok: false; error: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.authUrl()}/api/accounts/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
    } catch {
      throw new EngineError("unavailable", "Couldn't reach ChatGPT's sign-in service.");
    }
    if (res.status >= 500) throw new EngineError("unavailable", "ChatGPT's sign-in service is having trouble.");
    const json = (await res.json().catch(() => null)) as (TokenResponse & { error?: unknown }) | null;
    if (!res.ok || !json) return { ok: false, error: str(json?.error) ?? `http_${res.status}` };
    return { ok: true, body: json };
  }

  /** A usable access token, refreshed first if it's within five minutes of expiring. */
  async accessToken(userId: string): Promise<string> {
    const s = this.stored(userId);
    if (!s) throw new EngineError("auth", "Sign in to ChatGPT first.");
    if (s.expiresAt - Date.now() > REFRESH_WINDOW) return s.accessToken;
    return this.refresh(userId);
  }

  /**
   * Refresh now, for a request that came back 401. Pass the token that was rejected: if another caller has
   * already replaced it, that newer token is returned and no second refresh happens.
   */
  async refreshNow(userId: string, rejectedToken?: string): Promise<string> {
    const s = this.stored(userId);
    if (!s) throw new EngineError("auth", "Sign in to ChatGPT first.");
    if (rejectedToken && s.accessToken !== rejectedToken && s.expiresAt - Date.now() > REFRESH_WINDOW) return s.accessToken;
    return this.refresh(userId);
  }

  /** One refresh per user at a time: concurrent callers share it, since the refresh token rotates. */
  private refresh(userId: string): Promise<string> {
    let inFlight = this.refreshing.get(userId);
    if (!inFlight) {
      inFlight = this.doRefresh(userId).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, inFlight);
    }
    return inFlight;
  }

  private async doRefresh(userId: string): Promise<string> {
    const s = this.stored(userId);
    if (!s) throw new EngineError("auth", "Sign in to ChatGPT first.");
    let t: Awaited<ReturnType<ChatGPTAuth["tokenRequest"]>>;
    try {
      t = await this.tokenRequest({ grant_type: "refresh_token", client_id: s.clientId, refresh_token: s.refreshToken, resource: RESOURCE });
    } catch (err) {
      // A passing failure inside the five-minute window: the current token still works.
      if (s.expiresAt > Date.now() + 30_000) return s.accessToken;
      throw err;
    }
    if (!t.ok) {
      if (DEAD_GRANT.has(t.error)) {
        this.accounts.setSecret(userId, "chatgpt", null);
        // The registration itself is gone (e.g. disconnected in ChatGPT Settings): register afresh next time.
        if (t.error === "invalid_client" || t.error === "unauthorized_client") this.forgetClient(userId);
        this.errors.set(userId, SIGN_IN_AGAIN);
        throw new EngineError("auth", SIGN_IN_AGAIN);
      }
      throw new EngineError("unavailable", "Couldn't refresh the ChatGPT sign-in. Try again shortly.");
    }
    const body = t.body;
    if (!body.access_token) throw new EngineError("unavailable", "ChatGPT's refresh reply was incomplete.");
    // Signed out, or signed in again, while the request was out: don't resurrect or overwrite that.
    const now = this.stored(userId);
    if (!now) throw new EngineError("auth", SIGN_IN_AGAIN);
    if (now.refreshToken !== s.refreshToken) return now.accessToken;
    // The refresh token rotates: the old one is spent, so the new one must be saved with the access token.
    this.accounts.setSecret(userId, "chatgpt", {
      ...now,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? now.refreshToken,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    } satisfies Stored);
    return body.access_token;
  }

  // ---- Status and sign-out ------------------------------------------------------------------

  /** What the UI shows. Never includes a token. */
  status(userId: string): ChatGPTStatus {
    const s = this.stored(userId);
    const p = this.pending.get(userId);
    const out: ChatGPTStatus = { signedIn: !!s, pending: !!p && p.expiresAt >= Date.now() };
    if (s?.email) out.email = s.email;
    if (s?.plan) out.plan = s.plan;
    const err = this.errors.get(userId);
    if (err) out.lastError = err;
    return out;
  }

  /** Forget the tokens and revoke the refresh token. `revoked` is false when OpenAI couldn't be reached. */
  async signOut(userId: string): Promise<{ revoked: boolean }> {
    // A refresh in flight rotates the refresh token; let it land so the token we revoke is the live one.
    await this.refreshing.get(userId)?.catch(() => {});
    const s = this.stored(userId);
    this.endPending(userId);
    this.errors.delete(userId);
    this.accounts.setSecret(userId, "chatgpt", null);
    if (!s) return { revoked: true };
    // The revocation_endpoint in https://auth.openai.com/.well-known/openid-configuration.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${this.authUrl()}/api/accounts/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: s.refreshToken, token_type_hint: "refresh_token", client_id: s.clientId }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        if (res.ok) return { revoked: true };
        if (res.status < 500) return { revoked: false };
      } catch {
        // Retry once, then report that revocation wasn't confirmed.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { revoked: false };
  }
}
