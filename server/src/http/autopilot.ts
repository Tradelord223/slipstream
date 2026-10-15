import { Hono } from "hono";
import { z } from "zod";
import { autopilotSettingsPatch, senderRuleInput } from "../agents/autopilot.ts";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";

/** Autopilot's settings, decisions and sender rules. People only; agents read decisions with autopilot.list. */
export function autopilotRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const peopleOnly = async (c: { get(k: "actor"): { kind: string } }, next: () => Promise<void>) => {
    if (c.get("actor").kind !== "human") throw new HttpError(403, "Only a person can manage Autopilot.");
    await next();
  };
  app.use("/autopilot", peopleOnly);
  app.use("/autopilot/*", peopleOnly);
  const ap = ctx.autopilot;
  const uid = (c: { get(k: "user"): { id: string } }) => c.get("user").id;

  app.get("/autopilot", async (c) => c.json(await ap.overview(uid(c))));
  app.put("/autopilot", async (c) => c.json(await ap.update(uid(c), autopilotSettingsPatch.parse(await c.req.json()))));
  app.post("/autopilot/backfill", async (c) => {
    const { days } = z.object({ days: z.number().int().min(1).max(30) }).parse(await c.req.json());
    return c.json(await ap.backfill(uid(c), days));
  });
  app.post("/autopilot/run", async (c) => {
    await ap.tickUser(uid(c));
    return c.json(await ap.overview(uid(c)));
  });
  app.post("/autopilot/voice", async (c) => c.json(await ap.learnVoice(uid(c))));

  app.post("/autopilot/items/:id/accept", async (c) => {
    await ap.accept(uid(c), c.req.param("id"));
    return c.json(await ap.overview(uid(c)));
  });
  app.post("/autopilot/items/:id/dismiss", async (c) => {
    ap.dismiss(uid(c), c.req.param("id"));
    return c.json(await ap.overview(uid(c)));
  });
  app.post("/autopilot/items/:id/undo", async (c) => {
    await ap.undo(uid(c), c.req.param("id"));
    return c.json(await ap.overview(uid(c)));
  });
  app.post("/autopilot/accept-all", async (c) => {
    const accepted = await ap.acceptAll(uid(c));
    return c.json({ accepted, ...(await ap.overview(uid(c))) });
  });

  app.post("/autopilot/senders", async (c) => {
    ap.saveSenderRule(uid(c), senderRuleInput.parse(await c.req.json()));
    return c.json(await ap.overview(uid(c)));
  });
  app.delete("/autopilot/senders/:id", async (c) => {
    ap.deleteSenderRule(uid(c), c.req.param("id"));
    return c.json(await ap.overview(uid(c)));
  });

  return app;
}
