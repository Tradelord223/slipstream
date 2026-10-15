import { Hono } from "hono";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { newId } from "../lib/crypto.ts";
import {
  cancelSend,
  createDraft,
  deleteDraft,
  draftInput,
  draftRow,
  getDraft,
  listDrafts,
  sendDraft,
  sendOptions,
  updateDraft,
} from "../mail/drafts.ts";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function composeRoutes(ctx: AppContext) {
  const { db, store } = ctx;
  const app = new Hono<Env>();

  app.get("/drafts", (c) => c.json({ drafts: listDrafts(ctx, c.get("user").id) }));
  app.get("/drafts/:id", (c) => c.json(getDraft(ctx, c.get("user").id, c.req.param("id"))));
  app.post("/drafts", async (c) => c.json(createDraft(ctx, c.get("user").id, draftInput.parse(await c.req.json()))));
  app.put("/drafts/:id", async (c) => c.json(updateDraft(ctx, c.get("user").id, c.req.param("id"), draftInput.parse(await c.req.json()))));
  app.delete("/drafts/:id", (c) => {
    deleteDraft(ctx, c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/drafts/:id/send", async (c) => {
    const user = c.get("user");
    const opts = sendOptions.parse(await c.req.json().catch(() => ({})));
    const result = sendDraft(ctx, user.id, c.req.param("id"), opts);
    ctx.commands.record({ kind: "human", user }, "drafts.send", `Sent "${getDraft(ctx, user.id, result.id).subject || "(no subject)"}"`, {});
    return c.json(result);
  });

  app.post("/drafts/:id/cancel", (c) => c.json(cancelSend(ctx, c.get("user").id, c.req.param("id"))));

  app.post("/drafts/:id/attachments", async (c) => {
    const user = c.get("user");
    const d = draftRow(ctx, user.id, c.req.param("id"));
    const form = await c.req.formData();
    const added = [];
    for (const value of form.getAll("file")) {
      if (typeof value === "string") continue;
      if (value.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `${value.name} is over 25 MB`);
      const content = Buffer.from(await value.arrayBuffer());
      const id = newId("datt");
      db.run(
        "INSERT INTO draft_attachments (id, draft_id, filename, mime_type, size, blob_sha256) VALUES (?,?,?,?,?,?)",
        id,
        d.id,
        value.name.slice(0, 255) || "attachment",
        value.type || "application/octet-stream",
        content.length,
        store.saveBlob(content),
      );
      added.push(id);
    }
    return c.json(getDraft(ctx, user.id, d.id));
  });

  app.delete("/drafts/:id/attachments/:att", (c) => {
    const d = draftRow(ctx, c.get("user").id, c.req.param("id"));
    db.run("DELETE FROM draft_attachments WHERE id = ? AND draft_id = ?", c.req.param("att"), d.id);
    return c.json(getDraft(ctx, c.get("user").id, d.id));
  });

  return app;
}
