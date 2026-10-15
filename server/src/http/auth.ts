import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";

export const SESSION_COOKIE = "slipstream_session";

const signupBody = z.object({
  email: z.email().max(320),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(512),
  workspaceName: z.string().trim().min(1).max(120).optional(),
  invite: z.string().max(200).optional(),
});

const loginBody = z.object({ email: z.string().max(320), password: z.string().max(512) });

/** Naive per-process rate limit for password attempts. */
const attempts = new Map<string, { n: number; reset: number }>();
function throttle(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { n: 1, reset: now + 15 * 60_000 });
    return;
  }
  a.n += 1;
  if (a.n > 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
}

export function authRoutes(ctx: AppContext) {
  const { users, config } = ctx;
  const app = new Hono<Env>();
  const secure = config.publicUrl.startsWith("https://");

  const startSession = (c: Context<Env>, userId: string) => {
    setCookie(c, SESSION_COOKIE, users.createSession(userId), {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 86_400,
    });
  };

  /** What the sign-in screen should offer. */
  app.get("/state", (c) =>
    c.json({
      mode: config.mode,
      needsSetup: config.mode === "team" && users.count() === 0,
      openSignup: process.env.SLIPSTREAM_OPEN_SIGNUP === "1",
    }),
  );

  app.get("/invite", (c) => {
    const info = users.inviteInfo(c.req.query("token") ?? "");
    if (!info) return c.json({ error: "This invite link has expired or was already used." }, 404);
    return c.json({ workspace: info.workspace_name, email: info.email });
  });

  app.post("/signup", async (c) => {
    if (config.mode !== "team") throw new HttpError(400, "Accounts are only used in team mode.");
    const body = signupBody.parse(await c.req.json());
    throttle(`signup:${c.req.header("x-forwarded-for") ?? "local"}`);
    const first = users.count() === 0;
    // After the first owner, joining needs an invite unless the operator opened sign-ups.
    if (!first && !body.invite && process.env.SLIPSTREAM_OPEN_SIGNUP !== "1")
      throw new HttpError(403, "Ask a teammate for an invite link to join this workspace.");
    if (body.invite && !users.inviteInfo(body.invite)) throw new HttpError(400, "This invite link has expired or was already used.");

    const user = await users.create(body.email, body.name, body.password);
    if (body.invite) users.acceptInvite(body.invite, user.id, user.email);
    else if (first) users.createWorkspace(user.id, body.workspaceName ?? `${body.name.split(" ")[0]}'s team`);
    startSession(c, user.id);
    return c.json({ user });
  });

  app.post("/login", async (c) => {
    if (config.mode !== "team") throw new HttpError(400, "Local mode has no sign-in.");
    const body = loginBody.parse(await c.req.json());
    throttle(`login:${body.email.toLowerCase()}`);
    const user = await users.verify(body.email, body.password);
    if (!user) throw new HttpError(401, "That email and password don't match.");
    startSession(c, user.id);
    return c.json({ user });
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) users.destroySession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.post("/join", async (c) => {
    const { invite } = z.object({ invite: z.string() }).parse(await c.req.json());
    const user = c.get("user");
    users.acceptInvite(invite, user.id, user.email);
    return c.json({ workspace: users.workspaceOf(user.id) });
  });

  return app;
}
