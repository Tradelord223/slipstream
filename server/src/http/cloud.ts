import { Hono } from "hono";
import { z } from "zod";
import { cloudConnectInput, routineInput } from "../agents/cloud.ts";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";

/** The managed cloud agent: link with an API key, run it, schedule routines. People only. */
export function cloudRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.use("/cloud/*", async (c, next) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can manage the cloud agent.");
    await next();
  });
  app.use("/cloud", async (c, next) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can manage the cloud agent.");
    await next();
  });

  app.get("/cloud", (c) => c.json(ctx.cloud.status(c.get("user").id)));
  app.post("/cloud/connect", async (c) => c.json(await ctx.cloud.connect(c.get("user").id, cloudConnectInput.parse(await c.req.json()))));
  app.post("/cloud/disconnect", (c) => {
    ctx.cloud.disconnect(c.get("user").id);
    return c.json(ctx.cloud.status(c.get("user").id));
  });

  app.get("/cloud/runs", (c) => c.json({ runs: ctx.cloud.runs(c.get("user").id, 50) }));
  app.post("/cloud/runs", async (c) => {
    const { instruction } = z.object({ instruction: z.string().trim().min(1).max(8_000) }).parse(await c.req.json());
    return c.json(await ctx.cloud.start(c.get("user").id, instruction));
  });
  app.get("/cloud/runs/:id", (c) => c.json(ctx.cloud.run(c.get("user").id, c.req.param("id"))));
  app.post("/cloud/runs/:id/messages", async (c) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(8_000) }).parse(await c.req.json());
    return c.json(await ctx.cloud.reply(c.get("user").id, c.req.param("id"), text));
  });
  app.post("/cloud/runs/:id/stop", async (c) => c.json(await ctx.cloud.stop(c.get("user").id, c.req.param("id"))));

  app.post("/cloud/routines", async (c) => c.json(ctx.cloud.saveRoutine(c.get("user").id, routineInput.parse(await c.req.json()))));
  app.put("/cloud/routines/:id", async (c) => c.json(ctx.cloud.saveRoutine(c.get("user").id, routineInput.parse(await c.req.json()), c.req.param("id"))));
  app.delete("/cloud/routines/:id", (c) => {
    ctx.cloud.deleteRoutine(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/cloud/routines/:id/run", async (c) => c.json(await ctx.cloud.runRoutine(c.get("user").id, c.req.param("id"))));
  return app;
}
