import type { Config } from "../config.ts";
import { ProviderAuthError, type ProviderContext } from "../mail/types.ts";

/** OAuth flows for Google and Microsoft (authorization code + PKCE), and the token handling both mail providers share. */
export interface OAuthResult {
  auth: unknown;
  email: string;
  name: string;
}

/** What gets stored (encrypted) as an account's credentials. Times are ms since the epoch. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type OAuthKind = "google" | "microsoft";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_SCOPE = "openid email profile https://www.googleapis.com/auth/gmail.modify";

const MICROSOFT_SCOPE = "offline_access openid profile email User.Read Mail.ReadWrite Mail.Send";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";

/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 60_000;

export function googleRedirectUri(config: Config): string {
  return `${config.publicUrl}/api/oauth/google/callback`;
}

/** Microsoft only accepts http://localhost (any port) for loopback redirects, not 127.0.0.1. */
export function microsoftRedirectUri(config: Config): string {
  if (config.mode === "local") return `http://localhost:${config.port}/api/oauth/microsoft/callback`;
  return `${config.publicUrl}/api/oauth/microsoft/callback`;
}

function microsoftEndpoint(config: Config, path: "authorize" | "token"): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenant)}/oauth2/v2.0/${path}`;
}

export function googleAuthUrl(config: Config, state: string, codeChallenge: string): string {
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.google.clientId ?? "",
    redirect_uri: googleRedirectUri(config),
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function microsoftAuthUrl(config: Config, state: string, codeChallenge: string): string {
  const url = new URL(microsoftEndpoint(config, "authorize"));
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.microsoft.clientId ?? "",
    redirect_uri: microsoftRedirectUri(config),
    scope: MICROSOFT_SCOPE,
    response_mode: "query",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Parses a JSON body, tolerating the empty ones (202, 204) that Graph and Gmail return for writes. */
export async function jsonBody<T>(res: Response): Promise<T | undefined> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

async function postToken(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<{ res: Response; body: TokenResponse }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  return { res, body: (await jsonBody<TokenResponse>(res)) ?? {} };
}

function tokenError(what: string, res: Response, body: TokenResponse): Error {
  return new Error(`${what} (${res.status}${body.error ? ` ${body.error}` : ""}${body.error_description ? `: ${body.error_description.split("\n")[0]}` : ""})`);
}

function toTokens(body: TokenResponse, fallbackRefresh?: string): OAuthTokens | null {
  if (!body.access_token) return null;
  const refreshToken = body.refresh_token ?? fallbackRefresh;
  if (!refreshToken) return null;
  return { accessToken: body.access_token, refreshToken, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

export async function googleExchange(config: Config, code: string, verifier: string): Promise<OAuthResult> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: googleRedirectUri(config),
    client_id: config.google.clientId ?? "",
    code_verifier: verifier,
  };
  // Desktop-type clients come with a secret Google still expects at the token endpoint.
  if (config.google.clientSecret) params.client_secret = config.google.clientSecret;
  const { res, body } = await postToken(GOOGLE_TOKEN, params);
  if (!res.ok) throw tokenError("Google sign-in failed", res, body);
  const auth = toTokens(body);
  if (!auth) throw new Error("Google did not return a refresh token. Remove Slipstream from your Google account's connected apps and try again.");

  const infoRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const info = await jsonBody<{ email?: string; name?: string }>(infoRes);
  if (!infoRes.ok || !info?.email) throw new Error(`Could not read your Google profile (${infoRes.status})`);
  return { auth, email: info.email, name: info.name || info.email };
}

export async function microsoftExchange(config: Config, code: string, verifier: string): Promise<OAuthResult> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: microsoftRedirectUri(config),
    client_id: config.microsoft.clientId ?? "",
    code_verifier: verifier,
    scope: MICROSOFT_SCOPE,
  };
  if (config.microsoft.clientSecret) params.client_secret = config.microsoft.clientSecret;
  const { res, body } = await postToken(microsoftEndpoint(config, "token"), params);
  if (!res.ok) throw tokenError("Microsoft sign-in failed", res, body);
  const auth = toTokens(body);
  if (!auth) throw new Error("Microsoft did not return a refresh token");

  const meRes = await fetch(GRAPH_ME, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const me = await jsonBody<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>(meRes);
  const email = me?.mail ?? me?.userPrincipalName;
  if (!meRes.ok || !email) throw new Error(`Could not read your Microsoft profile (${meRes.status})`);
  return { auth, email, name: me?.displayName || email };
}

/**
 * Bearer-token fetch with token refresh, shared by the Gmail and Graph providers.
 * Refreshes shortly before expiry, and once on a 401; a second 401 or a revoked refresh token is a ProviderAuthError.
 */
export class OAuthSession {
  private tokens: OAuthTokens | null;
  private inflight: Promise<OAuthTokens> | null = null;

  private ctx: ProviderContext;
  private config: Config | undefined;
  private kind: OAuthKind;

  constructor(kind: OAuthKind, ctx: ProviderContext, config?: Config) {
    this.kind = kind;
    this.ctx = ctx;
    this.config = config;
    const a = ctx.auth as Partial<OAuthTokens> | null;
    this.tokens = a && typeof a.refreshToken === "string" ? { accessToken: a.accessToken ?? "", refreshToken: a.refreshToken, expiresAt: a.expiresAt ?? 0 } : null;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const first = await this.accessToken();
    const res = await this.send(url, init, first);
    if (res.status !== 401) return res;
    // Another request may already have rotated the token while this one was in flight.
    const fresh = this.tokens && this.tokens.accessToken !== first ? this.tokens.accessToken : (await this.refresh()).accessToken;
    const retry = await this.send(url, init, fresh);
    if (retry.status === 401) throw new ProviderAuthError("The provider rejected the access token; sign in again");
    return retry;
  }

  private send(url: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers, signal: init.signal ?? this.ctx.signal });
  }

  private async accessToken(): Promise<string> {
    const t = this.tokens;
    if (!t) throw new ProviderAuthError("No saved credentials; sign in again");
    if (t.accessToken && t.expiresAt - REFRESH_MARGIN_MS > Date.now()) return t.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** One refresh at a time: concurrent callers share it (Microsoft rotates refresh tokens). */
  private refresh(): Promise<OAuthTokens> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<OAuthTokens> {
    const current = this.tokens;
    if (!current) throw new ProviderAuthError("No saved credentials; sign in again");
    const google = this.kind === "google";
    const app = google ? this.config?.google : this.config?.microsoft;
    if (!this.config || !app?.clientId) throw new Error(`${google ? "Google" : "Microsoft"} sign-in is not configured on this server`);
    const params: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: app.clientId,
    };
    if (app.clientSecret) params.client_secret = app.clientSecret;
    if (!google) params.scope = MICROSOFT_SCOPE;
    const url = google ? GOOGLE_TOKEN : microsoftEndpoint(this.config, "token");

    const { res, body } = await postToken(url, params, this.ctx.signal);
    if (res.status === 400 || res.status === 401) {
      throw new ProviderAuthError(body.error_description?.split("\n")[0] ?? `Sign-in expired (${body.error ?? res.status}); sign in again`);
    }
    if (!res.ok) throw tokenError("Token refresh failed", res, body);
    const next = toTokens(body, current.refreshToken);
    if (!next) throw new Error("Token refresh returned no access token");
    this.tokens = next;
    this.ctx.saveAuth(next);
    return next;
  }
}
