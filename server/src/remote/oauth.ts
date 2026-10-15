import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { OAUTH_ACCESS_PREFIX, SCOPES, type Scope } from "../agents/agents.ts";
import { isPrivateAddress } from "../agents/webhooks.ts";
import { LOCAL_USER_ID } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { SESSION_COOKIE } from "../http/auth.ts";
import { newId, randomToken, sha256 } from "../lib/crypto.ts";
import { escapeHtml } from "../lib/text.ts";

/**
 * A small OAuth 2.1 authorization server so remote assistants (claude.ai, ChatGPT, Cursor…) can connect
 * to /mcp. There is no password: the person approves each connection in Slipstream's Review queue,
 * matching the pairing code the assistant's sign-in page shows. Each connection becomes an agent with
 * its own scopes, policy, activity and a revoke button.
 */

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 30 * 86_400_000;
const REQUEST_TTL = 10 * 60 * 1000;
const MAX_PENDING = 5;
const DEFAULT_SCOPES: Scope[] = ["read", "triage", "draft"];

export type OriginOf = (c: Context<Env>) => string;

interface ClientInfo {
  id: string;
  name: string;
  redirectUris: string[];
}

interface RequestRow {
  id: string;
  user_id: string;
  agent_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes: string;
  resource: string | null;
  pairing_code: string;
  status: string;
  code_hash: string | null;
  expires_at: number;
}

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    // Loopback redirects for desktop clients (any port), and app schemes like cursor:// or vscode://.
    if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "file:", "vbscript:"].includes(u.protocol);
  } catch {
    return false;
  }
}

/** Fetch a Client ID Metadata Document: https only, public hosts only, small, quick. */
function fetchClientMetadata(url: string): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== "https:") return Promise.reject(new Error("client_id must be an https URL"));
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      u,
      {
        method: "GET",
        headers: { accept: "application/json" },
        timeout: 5_000,
        lookup: (hostname, options, cb) =>
          dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return cb(err, "");
            const list = addresses as LookupAddress[];
            if (list.some((a) => isPrivateAddress(a.address))) return cb(new Error("client_id resolves to a private address"), "");
            cb(null, list);
          }),
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume();
          return reject(new Error(`client metadata returned ${res.statusCode}`));
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => {
          size += d.length;
          if (size > 64 * 1024) req.destroy(new Error("client metadata too large"));
          else chunks.push(d);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("client metadata isn't JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("client metadata timed out")));
    req.on("error", reject);
    req.end();
  });
}

const oauthError = (c: Context<Env>, error: string, description: string, status: 400 | 401 = 400) => {
  c.header("Cache-Control", "no-store");
  return c.json({ error, error_description: description }, status);
};

export function oauthRoutes(ctx: AppContext, originOf: OriginOf) {
  const { db, agents, commands, config, users } = ctx;
  const app = new Hono<Env>();

  commands.registerApprovalHandler("oauth.connect", {
    title: "Connect an assistant",
    approve: (_userId, input) => {
      const { requestId } = input as { requestId: string };
      db.run("UPDATE oauth_requests SET status = 'approved' WHERE id = ? AND status = 'pending'", requestId);
      const r = db.get<RequestRow>("SELECT * FROM oauth_requests WHERE id = ?", requestId);
      if (r) db.run("UPDATE agents SET status = 'active' WHERE id = ?", r.agent_id);
      return { requestId };
    },
    reject: (_userId, input) => {
      const { requestId } = input as { requestId: string };
      const r = db.get<RequestRow>("SELECT * FROM oauth_requests WHERE id = ?", requestId);
      db.run("UPDATE oauth_requests SET status = 'denied' WHERE id = ?", requestId);
      if (r) db.run("UPDATE agents SET revoked_at = ? WHERE id = ? AND status = 'pending'", Date.now(), r.agent_id);
    },
  });

  const resourceOf = (c: Context<Env>) => `${originOf(c)}/mcp`;

  const protectedResource = (c: Context<Env>) =>
    c.json({
      resource: resourceOf(c),
      authorization_servers: [originOf(c)],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Slipstream",
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const serverMetadata = (c: Context<Env>) => {
    const origin = originOf(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
      client_id_metadata_document_supported: true,
    });
  };
  app.get("/.well-known/oauth-authorization-server", serverMetadata);
  app.get("/.well-known/openid-configuration", serverMetadata);

  // ---- Dynamic Client Registration (RFC 7591) ---------------------------------

  app.post("/oauth/register", async (c) => {
    const body = z
      .object({ client_name: z.string().trim().max(100).optional(), redirect_uris: z.array(z.string().max(2000)).min(1).max(10) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return oauthError(c, "invalid_client_metadata", "redirect_uris is required");
    if (!body.data.redirect_uris.every(validRedirect)) return oauthError(c, "invalid_redirect_uri", "Redirect URIs must be https, loopback, or an app scheme");
    const recent = db.get<{ n: number }>("SELECT count(*) AS n FROM oauth_clients WHERE created_at > ?", Date.now() - 3_600_000)!.n;
    if (recent > 50) return oauthError(c, "temporarily_unavailable", "Too many registrations");
    const id = newId("oac");
    const name = body.data.client_name || "Assistant";
    db.run("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)", id, name, JSON.stringify(body.data.redirect_uris), Date.now());
    return c.json(
      { client_id: id, client_name: name, redirect_uris: body.data.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
      201,
    );
  });

  async function resolveClient(clientId: string): Promise<ClientInfo | null> {
    if (/^https:\/\//.test(clientId)) {
      // Client ID Metadata Document: the client_id is a URL that describes the client.
      const doc = z
        .object({ client_id: z.string(), client_name: z.string().max(100).optional(), redirect_uris: z.array(z.string()).min(1) })
        .safeParse(await fetchClientMetadata(clientId).catch(() => null));
      if (!doc.success || doc.data.client_id !== clientId || !doc.data.redirect_uris.every(validRedirect)) return null;
      return { id: clientId, name: doc.data.client_name || new URL(clientId).hostname, redirectUris: doc.data.redirect_uris };
    }
    const row = db.get<{ id: string; name: string; redirect_uris: string }>("SELECT * FROM oauth_clients WHERE id = ?", clientId);
    return row ? { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[] } : null;
  }

  /** Who is granting access: the signed-in person in team mode, the owner in local mode. */
  function grantingUser(c: Context<Env>): string | null {
    if (config.mode === "local") return LOCAL_USER_ID;
    return users.userForSession(getCookie(c, SESSION_COOKIE))?.id ?? null;
  }

  // ---- Authorization ------------------------------------------------------------

  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const client = q.client_id ? await resolveClient(q.client_id) : null;
    if (!client) return c.html(page("Can't connect", "This assistant isn't registered with Slipstream."), 400);
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri))
      return c.html(page("Can't connect", "The assistant sent a return address it didn't register."), 400);
    const back = (params: Record<string, string>) => {
      const u = new URL(q.redirect_uri!);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (q.state) u.searchParams.set("state", q.state);
      return c.redirect(u.toString());
    };
    if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (q.code_challenge_method !== "S256" || !q.code_challenge) return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    if (q.resource && q.resource !== resourceOf(c)) return back({ error: "invalid_target" });

    const userId = grantingUser(c);
    if (!userId) {
      const next = encodeURIComponent(c.req.url);
      return c.html(page("Sign in to Slipstream", `<a class="btn" href="/login?next=${next}">Sign in</a> to connect ${escapeHtml(client.name)}.`), 401);
    }

    db.run("UPDATE oauth_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", Date.now());
    const pending = db.get<{ n: number }>("SELECT count(*) AS n FROM oauth_requests WHERE user_id = ? AND status = 'pending'", userId)!.n;
    if (pending >= MAX_PENDING) return back({ error: "temporarily_unavailable", error_description: "Too many connection requests are waiting" });

    const requested = (q.scope ?? "").split(/\s+/).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
    const scopes = requested.length ? requested : DEFAULT_SCOPES;
    const pairing = randomToken(4).replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X");
    const requestId = newId("oar");

    // The connection becomes an agent once approved; until then it can't authenticate.
    const { agent } = agents.create(userId, client.name, scopes);
    db.run("UPDATE agents SET status = 'pending', oauth_client_id = ? WHERE id = ?", client.id, agent.id);
    db.run(
      `INSERT INTO oauth_requests (id, user_id, agent_id, client_id, redirect_uri, code_challenge, state, scopes, resource, pairing_code, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      requestId, userId, agent.id, client.id, q.redirect_uri, q.code_challenge, q.state ?? null, JSON.stringify(scopes),
      q.resource ?? null, pairing, Date.now(), Date.now() + REQUEST_TTL,
    );
    const user = users.get(userId)!;
    commands.requestCustomApproval(
      { kind: "agent", user, agent: { ...agent, status: "pending" } as typeof agent },
      "oauth.connect",
      { requestId },
      [
        `${client.name} wants to connect to your Slipstream.`,
        `Pairing code: ${pairing}`,
        `Access: ${scopes.join(", ")}`,
        `Returns to: ${new URL(q.redirect_uri).host || q.redirect_uri}`,
        "",
        "Approve only if you just started this connection and the code matches what you see.",
      ].join("\n"),
      "A new assistant wants access to your mail",
    );
    return c.html(waitingPage(client.name, pairing, requestId, scopes));
  });

  /** Polled by the waiting page; hands the code back once the person approves. */
  app.get("/oauth/authorize/status", (c) => {
    const r = db.get<RequestRow>("SELECT * FROM oauth_requests WHERE id = ?", c.req.query("id") ?? "");
    if (!r) return c.json({ status: "unknown" }, 404);
    if (r.status === "pending" && r.expires_at < Date.now()) return c.json({ status: "expired" });
    const back = new URL(r.redirect_uri);
    if (r.state) back.searchParams.set("state", r.state);
    if (r.status === "denied") {
      back.searchParams.set("error", "access_denied");
      return c.json({ status: "denied", redirect: back.toString() });
    }
    if (r.status !== "approved") return c.json({ status: r.status });
    // One-time: the code is minted on the first poll after approval.
    const code = randomToken(32);
    const claimed = db.run("UPDATE oauth_requests SET status = 'used', code_hash = ?, expires_at = ? WHERE id = ? AND status = 'approved'", sha256(code), Date.now() + 60_000, r.id);
    if (claimed.changes === 0) return c.json({ status: "used" });
    back.searchParams.set("code", code);
    return c.json({ status: "approved", redirect: back.toString() });
  });

  // ---- Tokens ---------------------------------------------------------------------

  function issueTokens(agentId: string) {
    const access = `${OAUTH_ACCESS_PREFIX}${randomToken(32)}`;
    const refresh = `ss_ort_${randomToken(32)}`;
    const now = Date.now();
    db.run(
      "INSERT INTO oauth_tokens (id, agent_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at) VALUES (?,?,?,?,?,?,?)",
      newId("oat"), agentId, sha256(access), sha256(refresh), now + ACCESS_TTL, now + REFRESH_TTL, now,
    );
    const scopes = db.get<{ scopes: string }>("SELECT scopes FROM agents WHERE id = ?", agentId)!.scopes;
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: (JSON.parse(scopes) as string[]).join(" ") };
  }

  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, string>);
    const f = form as Record<string, string | undefined>;
    if (f.grant_type === "authorization_code") {
      if (!f.code || !f.code_verifier || !f.redirect_uri || !f.client_id) return oauthError(c, "invalid_request", "code, code_verifier, redirect_uri and client_id are required");
      const r = db.get<RequestRow>("SELECT * FROM oauth_requests WHERE code_hash = ? AND status = 'used'", sha256(f.code));
      if (!r || r.expires_at < Date.now()) return oauthError(c, "invalid_grant", "The code is invalid or expired");
      // Codes are single use whatever happens next.
      db.run("UPDATE oauth_requests SET code_hash = NULL WHERE id = ?", r.id);
      const challenge = createHash("sha256").update(f.code_verifier).digest("base64url");
      if (challenge !== r.code_challenge || r.redirect_uri !== f.redirect_uri || r.client_id !== f.client_id)
        return oauthError(c, "invalid_grant", "The code doesn't match this client");
      return c.json(issueTokens(r.agent_id));
    }
    if (f.grant_type === "refresh_token") {
      if (!f.refresh_token) return oauthError(c, "invalid_request", "refresh_token is required");
      const t = db.get<{ id: string; agent_id: string; refresh_expires_at: number; revoked_at: number | null }>(
        `SELECT t.id, t.agent_id, t.refresh_expires_at, t.revoked_at FROM oauth_tokens t JOIN agents a ON a.id = t.agent_id
         WHERE t.refresh_hash = ? AND a.revoked_at IS NULL AND a.status = 'active'`,
        sha256(f.refresh_token),
      );
      if (!t || t.revoked_at || t.refresh_expires_at < Date.now()) return oauthError(c, "invalid_grant", "The refresh token is invalid or expired");
      // Rotation: the old pair stops working.
      db.run("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?", Date.now(), t.id);
      return c.json(issueTokens(t.agent_id));
    }
    return oauthError(c, "unsupported_grant_type", "Use authorization_code or refresh_token");
  });

  app.post("/oauth/revoke", async (c) => {
    const f = (await c.req.parseBody().catch(() => ({}))) as Record<string, string | undefined>;
    if (f.token) db.run("UPDATE oauth_tokens SET revoked_at = ? WHERE access_hash = ? OR refresh_hash = ?", Date.now(), sha256(f.token), sha256(f.token));
    return c.body(null, 200);
  });

  return app;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Slipstream</title><style>${CSS}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body></html>`;
}

function waitingPage(clientName: string, pairing: string, requestId: string, scopes: string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash("sha256").update(POLL_SCRIPT).digest("base64")}'; connect-src 'self'">
<title>Approve in Slipstream</title><style>${CSS}</style></head><body><main>
<h1>Approve in Slipstream</h1>
<p>${escapeHtml(clientName)} is asking for access to your mail (${escapeHtml(scopes.join(", "))}).</p>
<p>Open Slipstream → Review and approve the request with this code:</p>
<p class="code" aria-label="Pairing code">${escapeHtml(pairing)}</p>
<p class="quiet" id="status" role="status">Waiting for approval…</p>
</main><script data-id="${escapeHtml(requestId)}">${POLL_SCRIPT}</script></body></html>`;
}

const POLL_SCRIPT = `(()=>{const id=document.currentScript.dataset.id;const s=document.getElementById("status");const tick=async()=>{try{const r=await fetch("/oauth/authorize/status?id="+encodeURIComponent(id));const d=await r.json();if(d.redirect){s.textContent=d.status==="approved"?"Approved. Returning…":"Declined.";location.replace(d.redirect);return}if(d.status==="expired"||d.status==="used"||d.status==="unknown"){s.textContent="This request is no longer active. Start the connection again.";return}}catch(e){}setTimeout(tick,1500)};tick()})();`;

const CSS = `:root{color-scheme:dark light;--bg:#0B0D12;--panel:#11141B;--text:#E7EAF0;--text2:#A3ABBA;--accent:#5EE6C7;--line:#232937}
@media (prefers-color-scheme:light){:root{--bg:#F6F7F9;--panel:#fff;--text:#12151C;--text2:#4A5262;--accent:#0B7F66;--line:#E3E6EC}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:420px;margin:16px;padding:28px;background:var(--panel);border:1px solid var(--line);border-radius:8px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px;color:var(--text2)}
.code{font:600 28px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;color:var(--accent);margin:16px 0}
.quiet{font-size:13px}.btn{color:var(--accent)}`;
