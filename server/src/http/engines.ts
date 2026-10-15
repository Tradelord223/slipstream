import { Hono } from "hono";
import { z } from "zod";
import { PROVIDERS } from "../agents/engines/accounts.ts";
import { ENGINE_IDS } from "../agents/engines/types.ts";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";

/** Models & accounts: which engines can run agents, their keys and sign-ins, models and budgets. People only. */
export function engineRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const peopleOnly = async (c: { get(k: "actor"): { kind: string } }, next: () => Promise<void>) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can manage models and accounts.");
    await next();
  };
  app.use("/engines", peopleOnly);
  app.use("/engines/*", peopleOnly);

  const overview = async (userId: string) => ({
    ...(await ctx.cloud.enginesStatus(userId)),
    keys: Object.fromEntries(PROVIDERS.map((p) => [p, ctx.cloud.accounts.keySource(userId, p)])),
    budgets: ctx.cloud.budgets(userId),
    mode: ctx.config.mode,
  });

  app.get("/engines", async (c) => c.json(await overview(c.get("user").id)));

  app.put("/engines/default", async (c) => {
    const { engine } = z.object({ engine: z.enum(ENGINE_IDS) }).parse(await c.req.json());
    ctx.cloud.accounts.setDefaultEngine(c.get("user").id, engine);
    return c.json(await overview(c.get("user").id));
  });

  app.put("/engines/:id/model", async (c) => {
    const id = z.enum(ENGINE_IDS).parse(c.req.param("id"));
    const { model } = z.object({ model: z.string().trim().min(1).max(200).nullable() }).parse(await c.req.json());
    ctx.cloud.accounts.setModel(c.get("user").id, id, model);
    return c.json(await overview(c.get("user").id));
  });

  app.put("/engines/keys/:provider", async (c) => {
    const provider = z.enum(PROVIDERS).parse(c.req.param("provider"));
    const { apiKey } = z.object({ apiKey: z.string().trim().min(8).max(500) }).parse(await c.req.json());
    ctx.cloud.accounts.setKey(c.get("user").id, provider, apiKey);
    return c.json(await overview(c.get("user").id));
  });

  app.delete("/engines/keys/:provider", async (c) => {
    const provider = z.enum(PROVIDERS).parse(c.req.param("provider"));
    ctx.cloud.accounts.setKey(c.get("user").id, provider, null);
    return c.json(await overview(c.get("user").id));
  });

  app.put("/engines/budgets", async (c) => {
    const b = z
      .object({ runBudgetCents: z.number().int().min(10).max(10_000).optional(), monthlyBudgetCents: z.number().int().min(100).max(1_000_000).optional() })
      .parse(await c.req.json());
    ctx.cloud.setBudgets(c.get("user").id, b);
    return c.json(await overview(c.get("user").id));
  });

  // ---- Sign in with ChatGPT ----------------------------------------------------------

  app.post("/engines/chatgpt/signin", async (c) => c.json(await ctx.cloud.chatgpt.begin(c.get("user").id)));
  /** Paste mode: the address the browser landed on after signing in. */
  app.post("/engines/chatgpt/complete", async (c) => {
    const { url } = z.object({ url: z.string().trim().min(10).max(8_000) }).parse(await c.req.json());
    await ctx.cloud.chatgpt.complete(c.get("user").id, url);
    return c.json(await overview(c.get("user").id));
  });
  app.post("/engines/chatgpt/signout", async (c) => {
    const { revoked } = await ctx.cloud.chatgpt.signOut(c.get("user").id);
    return c.json({ revoked, ...(await overview(c.get("user").id)) });
  });

  return app;
}
