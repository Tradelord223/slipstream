import { Hono } from "hono";
import { z } from "zod";
import { draftReply, explainAiError, summarizeThread, type AiMessage } from "../ai.ts";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { htmlToText, stripQuoted } from "../lib/text.ts";

export function aiRoutes(ctx: AppContext) {
  const { db, config, secrets } = ctx;
  const app = new Hono<Env>();

  const apiKeyFor = (userId: string): string => {
    const stored = db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = 'secret:anthropic'", userId);
    const key = stored ? secrets.open<string>(JSON.parse(stored.value) as string) : config.anthropicApiKey;
    if (!key) throw new HttpError(400, "Add an Anthropic API key in Settings → AI to use this.");
    return key;
  };

  const threadMessages = (userId: string, threadId: string) => {
    const owned = db.get<{ account_id: string }>(
      "SELECT t.account_id FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.id = ? AND a.user_id = ?",
      threadId,
      userId,
    );
    if (!owned) throw new HttpError(404, "Conversation not found");
    const rows = db.all<{ from_name: string; from_email: string; to_json: string; sent_at: number; subject: string; body_text: string; body_html: string | null }>(
      "SELECT from_name, from_email, to_json, sent_at, subject, body_text, body_html FROM messages WHERE thread_id = ? ORDER BY sent_at",
      threadId,
    );
    const account = db.get<{ name: string; email: string }>("SELECT name, email FROM accounts WHERE id = ?", owned.account_id)!;
    const messages: AiMessage[] = rows.map((r) => ({
      from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email,
      to: (JSON.parse(r.to_json) as { email: string }[]).map((a) => a.email).join(", "),
      sentAt: r.sent_at,
      subject: r.subject,
      text: stripQuoted(r.body_text || (r.body_html ? htmlToText(r.body_html) : "")),
    }));
    return { messages, me: account };
  };

  const run = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.error("[slipstream] ai:", err);
      throw new HttpError(502, explainAiError(err));
    }
  };

  app.post("/ai/summarize", async (c) => {
    const user = c.get("user");
    const { threadId } = z.object({ threadId: z.string() }).parse(await c.req.json());
    const key = apiKeyFor(user.id);
    const { messages } = threadMessages(user.id, threadId);
    const summary = await run(() => summarizeThread(key, messages));
    return c.json({ summary });
  });

  app.post("/ai/draft", async (c) => {
    const user = c.get("user");
    const body = z
      .object({ threadId: z.string().optional(), instruction: z.string().max(4_000).default(""), currentDraft: z.string().max(50_000).optional() })
      .parse(await c.req.json());
    const key = apiKeyFor(user.id);
    const thread = body.threadId ? threadMessages(user.id, body.threadId) : { messages: [], me: { name: user.name, email: user.email } };
    const text = await run(() => draftReply(key, { ...thread, instruction: body.instruction, currentDraft: body.currentDraft }));
    return c.json({ text });
  });

  return app;
}
