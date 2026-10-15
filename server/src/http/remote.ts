import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { oauthRoutes, type OriginOf } from "../remote/oauth.ts";
import { share, tailscaleState } from "../remote/tailscale.ts";
import { handleMcp } from "./v1.ts";

/**
 * Remote access to MCP. In local mode a second listener (loopback, port + 1) serves only /mcp,
 * /oauth and /.well-known, and that's what Tailscale Serve/Funnel (or any tunnel) points at.
 * The dashboard and its API are never reachable through it.
 */

let sharedOrigin: string | null = null;

export function remotePort(ctx: AppContext): number {
  return Number(process.env.SLIPSTREAM_REMOTE_PORT ?? ctx.config.port + 1);
}

/**
 * The origin remote clients see: the team server's URL, a configured tunnel URL, or this machine's
 * Tailscale name. Request headers never decide it (they'd let a client pick the issuer and audience),
 * unless the operator opts in with SLIPSTREAM_TRUST_PROXY=1 behind a proxy they control.
 */
export function makeOriginOf(ctx: AppContext, listener: "main" | "public"): OriginOf {
  return (c) => {
    if (ctx.config.mode === "team" || listener === "main") return ctx.config.publicUrl;
    const configured = process.env.SLIPSTREAM_REMOTE_URL?.replace(/\/$/, "");
    if (configured) return configured;
    if (sharedOrigin) return sharedOrigin;
    if (process.env.SLIPSTREAM_TRUST_PROXY === "1") {
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      const proto = c.req.header("x-forwarded-proto") ?? "https";
      if (host) return `${proto}://${host}`;
    }
    return `http://127.0.0.1:${remotePort(ctx)}`;
  };
}

/** Learn this machine's Tailscale address at boot and every few minutes, so discovery is right from the first request. */
export function watchRemoteOrigin(ctx: AppContext): () => void {
  if (ctx.config.mode !== "local") return () => {};
  const refresh = () =>
    void tailscaleState(remotePort(ctx))
      .then((t) => {
        const active = t.funnel ?? t.serve;
        sharedOrigin = active?.url ?? null;
      })
      .catch(() => {});
  refresh();
  const timer = setInterval(refresh, 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Hosts the public listener answers to: loopback, Tailscale names, and the configured public origin. */
function allowedPublicHost(ctx: AppContext, host: string): boolean {
  const port = remotePort(ctx);
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`) return true;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (name.endsWith(".ts.net")) return true;
  for (const origin of [process.env.SLIPSTREAM_REMOTE_URL, sharedOrigin]) {
    if (!origin) continue;
    try {
      if (new URL(origin).host.toLowerCase() === host.toLowerCase()) return true;
    } catch {
      /* ignore a malformed setting */
    }
  }
  return process.env.SLIPSTREAM_TRUST_PROXY === "1";
}

/** Bearer-only auth for /mcp on the public listener. */
function bearerOnly(ctx: AppContext, originOf: OriginOf) {
  return async (c: Context<Env>, next: Next) => {
    const h = c.req.header("authorization") ?? "";
    const token = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : "";
    const agent = token ? ctx.agents.authenticate(token) : null;
    const user = agent ? ctx.users.get(agent.userId) : null;
    if (!agent || !user) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${originOf(c)}/.well-known/oauth-protected-resource"`);
      return c.json({ error: token ? "Invalid or expired token" : "Authorization required" }, 401);
    }
    c.set("user", user);
    c.set("actor", { kind: "agent", user, agent });
    return next();
  };
}

export function createPublicApp(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();
  const originOf = makeOriginOf(ctx, "public");
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error("[slipstream] remote request failed:", err);
    return c.json({ error: "Something went wrong" }, 500);
  });
  app.use("*", async (c, next) => {
    // DNS rebinding: a page on another domain pointing its name at 127.0.0.1 gets nothing here.
    if (!allowedPublicHost(ctx, c.req.header("host") ?? "")) return c.text("Unknown host", 421);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
  });
  app.get("/", (c) => c.text("Slipstream MCP endpoint: /mcp"));
  app.route("/", oauthRoutes(ctx, originOf));
  app.use("/mcp", bearerOnly(ctx, originOf));
  app.all("/mcp", (c) => handleMcp(ctx, c.get("actor"), c.req.raw));
  app.all("*", (c) => c.json({ error: "Not found" }, 404));
  return app;
}

/** Dashboard controls for remote access (people only). */
export function remoteRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const port = remotePort(ctx);

  const view = async () => {
    const tailscale = ctx.config.mode === "local" ? await tailscaleState(port) : { installed: false, running: false, dnsName: null, serve: null, funnel: null };
    const active = tailscale.funnel ?? tailscale.serve;
    sharedOrigin = active?.url ?? null;
    return {
      mode: ctx.config.mode,
      tailscale,
      publicListener: ctx.config.mode === "local" ? { port } : null,
      mcpUrl: ctx.config.mode === "team" ? `${ctx.config.publicUrl}/mcp` : active ? `${active.url}/mcp` : null,
      localMcpUrl: `${ctx.config.publicUrl}/mcp`,
    };
  };

  app.get("/remote", async (c) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can do this.");
    return c.json(await view());
  });

  app.post("/remote/tailscale", async (c) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can do this.");
    if (ctx.config.mode !== "local") throw new HttpError(400, "Team servers already have a public address; use it directly.");
    const { mode } = z.object({ mode: z.enum(["serve", "funnel", "off"]) }).parse(await c.req.json());
    try {
      await share(mode, port);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    ctx.commands.record(c.get("actor"), "remote.share", mode === "off" ? "Stopped sharing MCP over Tailscale" : `Shared MCP over Tailscale ${mode === "funnel" ? "Funnel (public)" : "Serve (your devices)"}`, {});
    return c.json(await view());
  });

  return app;
}
