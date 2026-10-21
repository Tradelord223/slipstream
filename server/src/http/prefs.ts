import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { newId } from "../lib/crypto.ts";
import { sanitizeOutgoingHtml } from "../lib/sanitize.ts";
import { assistantSetting } from "../agents/assistant.ts";
import { describeAvailable, describeSplit } from "../mail/describe.ts";
import { dismissSuggestion } from "../mail/suggest.ts";
import { createSplit, updateSplit } from "../prefs.ts";

/** Settings the client may read and write. Anything else is rejected. */
const settingsSchema = z
  .object({
    theme: z.enum(["system", "dark", "light"]),
    density: z.enum(["comfortable", "compact"]),
    remoteImages: z.enum(["ask", "always"]),
    autoAdvance: z.enum(["next", "previous", "list"]),
    signature: z.string().max(20_000),
    keymap: z.record(z.string().max(40), z.string().max(40)),
    instantIntro: z.string().max(2_000),
    defaultRemindHour: z.number().int().min(0).max(23),
    showTips: z.boolean(),
    unifiedInbox: z.boolean(),
    assistant: z.enum(["on", "off"]),
    senderLogos: z.boolean(),
    onboarded: z.boolean(),
    /** How much disk the cache of full message text may use, in megabytes; older read mail goes back to previews past it. */
    cacheLimitMb: z.number().int().min(10).max(1_000_000),
    helpers: z.strictObject({
      codes: z.boolean(),
      deliveries: z.enum(["latest", "all"]),
      securityAlerts: z.boolean(),
      urgent: z.boolean(),
    }),
  })
  .partial();

const splitBody = z.object({
  name: z.string().trim().min(1).max(60),
  query: z.string().trim().min(1).max(500),
  hideWhenEmpty: z.boolean().optional(),
  hidden: z.boolean().optional(),
});
/** Any part of a tab; a built-in tab accepts everything but a new query. */
const splitPatch = splitBody.partial();
const snippetBody = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().max(998).nullable().optional(),
  bodyHtml: z.string().max(200_000),
  shared: z.boolean().default(false),
});

export function prefsRoutes(ctx: AppContext) {
  const { db, users } = ctx;
  const app = new Hono<Env>();

  app.put("/settings", async (c) => {
    const user = c.get("user");
    const body = settingsSchema.parse(await c.req.json());
    // Switching the assistant back on resumes from now rather than catching up on everything that arrived while it was off.
    const resuming = body.assistant === "on" && assistantSetting(ctx, user.id) === "off";
    db.tx(() => {
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        const value = k === "signature" ? sanitizeOutgoingHtml(String(v)) : v;
        db.run(
          "INSERT INTO settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
          user.id,
          k,
          JSON.stringify(value),
        );
      }
    });
    if (resuming) {
      ctx.autopilot.resumeFromNow(user.id);
      ctx.cloud.resumeRoutinesFromNow(user.id);
    }
    return c.json({ ok: true });
  });

  /** Bring-your-own AI key. Stored sealed; never returned to the browser. */
  app.put("/settings/ai-key", async (c) => {
    const user = c.get("user");
    const { apiKey } = z.object({ apiKey: z.string().trim().max(500) }).parse(await c.req.json());
    if (!apiKey) db.run("DELETE FROM settings WHERE user_id = ? AND key = 'secret:anthropic'", user.id);
    else
      db.run(
        "INSERT INTO settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
        user.id,
        "secret:anthropic",
        JSON.stringify(ctx.secrets.seal(apiKey)),
      );
    return c.json({ ok: true });
  });

  // ---- Splits -------------------------------------------------------------

  app.post("/splits", async (c) => {
    const body = splitBody.parse(await c.req.json());
    return c.json(createSplit(ctx, c.get("user").id, body.name, body.query, body));
  });

  app.put("/splits/:id", async (c) => {
    const body = splitPatch.parse(await c.req.json());
    return c.json({ ok: true, split: updateSplit(ctx, c.get("user").id, c.req.param("id"), body).split });
  });

  // Removing a tab goes through the command registry, so it is recorded in Activity and can be undone with its activityId.
  app.delete("/splits/:id", async (c) => {
    const res = await ctx.commands.execute(c.get("actor"), "splits.delete", { splitId: c.req.param("id") });
    return c.json({ ok: true, activityId: res.status === "done" ? res.activityId : null });
  });

  app.put("/splits-order", async (c) => {
    const user = c.get("user");
    const { ids } = z.object({ ids: z.array(z.string()).max(50) }).parse(await c.req.json());
    db.tx(() => ids.forEach((id, i) => db.run("UPDATE splits SET position = ? WHERE id = ? AND user_id = ?", i, id, user.id)));
    return c.json({ ok: true });
  });

  /** Not suggesting this one again. The suggestions themselves come from the splits.suggest command. */
  app.post("/splits/suggestions/dismiss", async (c) => {
    const { key } = z.object({ key: z.string().trim().min(1).max(400) }).parse(await c.req.json());
    dismissSuggestion(ctx, c.get("user").id, key);
    return c.json({ ok: true });
  });

  /** Whether a model is connected that can turn a description into a search. The box that takes a description is shown only if so. */
  app.get("/splits/describe", async (c) => c.json(await describeAvailable(ctx, c.get("user").id)));

  /** A description in words as a search, with how many conversations it holds. Saves nothing. */
  app.post("/splits/describe", async (c) => {
    const { description } = z.object({ description: z.string().trim().min(3).max(300) }).parse(await c.req.json());
    return c.json(await describeSplit(ctx, c.get("user").id, description, c.req.raw.signal));
  });

  // ---- Snippets (personal, or shared with the workspace) -----------------

  app.get("/snippets", (c) => {
    const user = c.get("user");
    const ws = users.workspaceOf(user.id);
    const rows = db.all<{ id: string; user_id: string; workspace_id: string | null; name: string; subject: string | null; body_html: string; use_count: number; author: string }>(
      `SELECT s.*, u.name AS author FROM snippets s JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ? OR (s.workspace_id IS NOT NULL AND s.workspace_id = ?)
       ORDER BY s.use_count DESC, s.name`,
      user.id,
      ws?.id ?? "",
    );
    return c.json({
      snippets: rows.map((s) => ({
        id: s.id,
        name: s.name,
        subject: s.subject,
        bodyHtml: s.body_html,
        shared: Boolean(s.workspace_id),
        mine: s.user_id === user.id,
        author: s.author,
        useCount: s.use_count,
      })),
    });
  });

  app.post("/snippets", async (c) => {
    const user = c.get("user");
    const body = snippetBody.parse(await c.req.json());
    const ws = body.shared ? users.workspaceOf(user.id) : null;
    if (body.shared && !ws) throw new HttpError(400, "Join a team to share snippets");
    const id = newId("snp");
    db.run(
      "INSERT INTO snippets (id, user_id, workspace_id, name, subject, body_html, updated_at) VALUES (?,?,?,?,?,?,?)",
      id, user.id, ws?.id ?? null, body.name, body.subject ?? null, sanitizeOutgoingHtml(body.bodyHtml), Date.now(),
    );
    if (ws) ctx.events.emitToWorkspace(ws.id, { type: "team", workspaceId: ws.id, sharedThreadId: "" });
    return c.json({ id });
  });

  app.put("/snippets/:id", async (c) => {
    const user = c.get("user");
    const body = snippetBody.parse(await c.req.json());
    const ws = body.shared ? users.workspaceOf(user.id) : null;
    const res = db.run(
      "UPDATE snippets SET name = ?, subject = ?, body_html = ?, workspace_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      body.name, body.subject ?? null, sanitizeOutgoingHtml(body.bodyHtml), ws?.id ?? null, Date.now(), c.req.param("id"), user.id,
    );
    if (res.changes === 0) throw new HttpError(404, "Only the author can edit a snippet");
    return c.json({ ok: true });
  });

  app.post("/snippets/:id/used", (c) => {
    const user = c.get("user");
    const ws = users.workspaceOf(user.id);
    db.run(
      "UPDATE snippets SET use_count = use_count + 1 WHERE id = ? AND (user_id = ? OR workspace_id = ?)",
      c.req.param("id"),
      user.id,
      ws?.id ?? "",
    );
    return c.json({ ok: true });
  });

  app.delete("/snippets/:id", (c) => {
    const res = db.run("DELETE FROM snippets WHERE id = ? AND user_id = ?", c.req.param("id"), c.get("user").id);
    if (res.changes === 0) throw new HttpError(404, "Only the author can delete a snippet");
    return c.json({ ok: true });
  });

  return app;
}
