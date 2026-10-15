import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { ZodError } from "zod";
import { HttpError, LOCAL_USER_ID } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { accountRoutes } from "./accounts.ts";
import { aiRoutes } from "./ai.ts";
import { authRoutes, SESSION_COOKIE } from "./auth.ts";
import { composeRoutes } from "./compose.ts";
import { mailRoutes } from "./mail.ts";
import { prefsRoutes } from "./prefs.ts";
import { teamRoutes } from "./team.ts";

/** Paths reachable without a session in team mode. */
const PUBLIC_API = new Set(["/api/auth/login", "/api/auth/signup", "/api/auth/state", "/api/auth/invite"]);
/** Browser navigations (no custom header possible): OAuth redirects and downloads use GET with a session cookie. */
const NAVIGATION_GET = [/^\/api\/oauth\/(google|microsoft)\/(start|callback)$/, /^\/api\/attachments\/[\w-]+$/, /^\/api\/events$/];

export function createApp(ctx: AppContext, staticDir?: string): Hono<Env> {
  const app = new Hono<Env>();
  const { config, users } = ctx;

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    console.error("[slipstream] request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : "Something went wrong" }, 500);
  });

  // Host allowlist: the local server holds mail credentials, so a page on another domain
  // that rebinds its DNS to 127.0.0.1 must not be able to talk to it.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!config.allowedHosts.has(host)) return c.text("Unknown host", 421);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    const isNavigation = c.req.method === "GET" && NAVIGATION_GET.some((re) => re.test(path));

    if (!isNavigation) {
      // CSRF: a custom header can't be sent cross-origin without a CORS preflight we never approve.
      if (c.req.header("x-slipstream") !== "1") return c.json({ error: "Missing client header" }, 403);
      const origin = c.req.header("origin");
      if (origin && !config.allowedHosts.has(new URL(origin).host)) return c.json({ error: "Cross-origin request" }, 403);
    }

    if (config.mode === "local") {
      c.set("user", users.get(LOCAL_USER_ID)!);
      return next();
    }
    if (PUBLIC_API.has(path)) return next();
    const user = users.userForSession(getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: "Sign in required" }, 401);
    c.set("user", user);
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", authRoutes(ctx));
  app.route("/api", mailRoutes(ctx));
  app.route("/api", composeRoutes(ctx));
  app.route("/api", accountRoutes(ctx));
  app.route("/api", prefsRoutes(ctx));
  app.route("/api", teamRoutes(ctx));
  app.route("/api", aiRoutes(ctx));
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (staticDir && existsSync(staticDir)) {
    const index = readFileSync(join(staticDir, "index.html"));
    app.get("*", (c) => {
      const rel = normalize(decodeURIComponent(c.req.path)).replace(/^(\.\.[/\\])+/, "");
      const file = join(staticDir, rel);
      if (file.startsWith(staticDir) && rel !== "/" && existsSync(file) && !file.endsWith("/")) {
        try {
          const body = readFileSync(file);
          const type = MIME[file.slice(file.lastIndexOf(".") + 1)] ?? "application/octet-stream";
          const immutable = rel.startsWith("/assets/");
          return c.body(body, 200, {
            "content-type": type,
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          });
        } catch {
          /* directory: fall through to the SPA */
        }
      }
      return c.body(index, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...PAGE_HEADERS });
    });
  }
  return app;
}

const PAGE_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Message bodies render in sandboxed srcdoc frames; remote images are opt-in per message.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' about: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const MIME: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  json: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
};
