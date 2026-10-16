import { Hono } from "hono";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { HttpError } from "../auth/users.ts";
import type { AppContext, Env } from "../context.ts";
import { newId, randomToken } from "../lib/crypto.ts";
import { readMailFile } from "../import/mailfile.ts";
import { addIdentity, removeIdentity, updateIdentity } from "../mail/identities.ts";
import type { AccountRow } from "../mail/store.ts";
import type { IncomingMessage } from "../mail/types.ts";
import { discover, type DiscoverDeps } from "../providers/discover.ts";
import { IMAP_PRESETS, verifyImap, type ImapSettings } from "../providers/imap.ts";
import { googleAuthUrl, googleExchange, microsoftAuthUrl, microsoftExchange, type OAuthResult } from "../providers/oauth.ts";

/** Messages stored per step of an import; progress is reported after each. */
const IMPORT_BATCH = 250;

const ACCOUNT_COLORS = ["#5EE6C7", "#8AB4FF", "#F5B544", "#FF8FA3", "#B79CFF", "#7FD67A"];

const imapBody = z.object({
  email: z.email(),
  name: z.string().trim().max(120).default(""),
  preset: z.enum(Object.keys(IMAP_PRESETS) as [string, ...string[]]).optional(),
  username: z.string().max(320).optional(),
  password: z.string().min(1).max(1024),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
});

/** Seams for tests: the IMAP sign-in check and the DNS lookups need real servers otherwise. */
export interface AccountDeps {
  verifyImap?: (settings: ImapSettings) => Promise<void>;
  discover?: DiscoverDeps;
}

/**
 * Address lookups that may hit DNS at once: per person, so one tab can't use them all up, and in total, so the route
 * can't be used to flood a resolver. Past either, ask the caller to wait.
 */
const MAX_DISCOVERIES_PER_USER = 4;
const MAX_DISCOVERIES = 16;

export function accountRoutes(ctx: AppContext, deps: AccountDeps = {}) {
  const { db, sync, secrets, config, store, events, imports } = ctx;
  const verify = deps.verifyImap ?? verifyImap;
  let discovering = 0;
  const discoveringBy = new Map<string, number>();
  const app = new Hono<Env>();

  const nextColor = (userId: string) => {
    const n = db.get<{ n: number }>("SELECT count(*) AS n FROM accounts WHERE user_id = ?", userId)!.n;
    return ACCOUNT_COLORS[n % ACCOUNT_COLORS.length]!;
  };

  /** Removes an account and everything synced from it. */
  const removeAccount = async (accountId: string) => {
    await sync.forget(accountId);
    db.tx(() => {
      // Contentless FTS rows aren't removed by the cascade; clear them first.
      db.run("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id = ?)", accountId);
      db.run("DELETE FROM accounts WHERE id = ?", accountId);
    });
  };

  /**
   * Connecting real mail retires the invented demo mailbox (it only exists in developer demo mode, where it stays).
   * The client hears about it as a change to those threads, the same event a sync sends.
   */
  const dropDemoAccounts = async (userId: string) => {
    if (config.demo) return;
    for (const demo of db.all<{ id: string }>("SELECT id FROM accounts WHERE user_id = ? AND provider = 'demo'", userId)) {
      const threadIds = db.all<{ id: string }>("SELECT id FROM threads WHERE account_id = ?", demo.id).map((t) => t.id);
      await removeAccount(demo.id);
      events.emitToUser(userId, { type: "threads", accountId: demo.id, threadIds });
    }
  };

  const upsertAccount = async (userId: string, provider: string, email: string, name: string, auth: unknown): Promise<string> => {
    await dropDemoAccounts(userId);
    const existing = db.get<{ id: string }>(
      "SELECT id FROM accounts WHERE user_id = ? AND provider = ? AND email = ?",
      userId,
      provider,
      email,
    );
    if (existing) {
      db.run(
        "UPDATE accounts SET auth_enc = ?, name = ?, sync_status = 'idle', sync_error = NULL WHERE id = ?",
        secrets.seal(auth),
        name,
        existing.id,
      );
      void sync.forget(existing.id).then(() => sync.syncAccount(existing.id));
      return existing.id;
    }
    const id = newId("acc");
    db.run(
      "INSERT INTO accounts (id, user_id, provider, email, name, color, auth_enc, created_at) VALUES (?,?,?,?,?,?,?,?)",
      id, userId, provider, email.toLowerCase(), name, nextColor(userId), auth === null ? null : secrets.seal(auth), Date.now(),
    );
    void sync.syncAccount(id);
    return id;
  };

  app.get("/accounts/presets", (c) =>
    c.json({ presets: Object.entries(IMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, help: p.help })) }),
  );

  /** Where an address's mail lives, from its own domain's DNS. Used by the "add an account" screen before anything is saved. */
  app.get("/accounts/discover", async (c) => {
    const email = z.email().parse((c.req.query("email") ?? "").trim());
    const userId = c.get("user").id;
    const mine = discoveringBy.get(userId) ?? 0;
    if (mine >= MAX_DISCOVERIES_PER_USER || discovering >= MAX_DISCOVERIES) throw new HttpError(429, "Too many lookups at once; try again in a moment");
    discovering++;
    discoveringBy.set(userId, mine + 1);
    try {
      return c.json(await discover(email, config, deps.discover));
    } finally {
      discovering--;
      const left = (discoveringBy.get(userId) ?? 1) - 1;
      if (left > 0) discoveringBy.set(userId, left);
      else discoveringBy.delete(userId);
    }
  });

  app.post("/accounts/imap", async (c) => {
    const user = c.get("user");
    const body = imapBody.parse(await c.req.json());
    const preset = body.preset ? IMAP_PRESETS[body.preset] : undefined;
    const settings: ImapSettings = {
      username: body.username || body.email,
      password: body.password,
      imapHost: body.imapHost ?? preset?.imapHost ?? "",
      imapPort: body.imapPort ?? preset?.imapPort ?? 993,
      imapSecure: body.imapSecure ?? preset?.imapSecure ?? true,
      smtpHost: body.smtpHost ?? preset?.smtpHost ?? "",
      smtpPort: body.smtpPort ?? preset?.smtpPort ?? 465,
      smtpSecure: body.smtpSecure ?? preset?.smtpSecure ?? true,
    };
    if (!settings.imapHost || !settings.smtpHost) throw new HttpError(400, "Enter the IMAP and SMTP server names");
    await verify(settings).catch((err: Error) => {
      throw new HttpError(400, `Couldn't sign in: ${err.message}`);
    });
    const id = await upsertAccount(user.id, "imap", body.email, body.name, settings);
    return c.json({ id });
  });

  app.post("/accounts/:id/sync", async (c) => {
    const user = c.get("user");
    const acc = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    if (!acc) throw new HttpError(404, "Account not found");
    if (acc.sync_status === "reauth") db.run("UPDATE accounts SET sync_status = 'idle' WHERE id = ?", acc.id);
    void sync.syncAccount(acc.id);
    return c.json({ ok: true });
  });

  app.patch("/accounts/:id", async (c) => {
    const user = c.get("user");
    const body = z.object({ name: z.string().trim().max(120).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }).parse(await c.req.json());
    const acc = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    if (!acc) throw new HttpError(404, "Account not found");
    db.run("UPDATE accounts SET name = coalesce(?, name), color = coalesce(?, color) WHERE id = ?", body.name ?? null, body.color ?? null, acc.id);
    return c.json({ ok: true });
  });

  // ---- Send-as identities --------------------------------------------------

  const emailField = z.string().trim().toLowerCase().max(320).pipe(z.email());
  const identityFields = {
    email: emailField,
    name: z.string().trim().max(120),
    replyTo: emailField.nullable().optional(),
    signatureHtml: z.string().max(100_000).nullable().optional(),
  };
  const identityBody = z.object({ ...identityFields, name: identityFields.name.default("") });
  // No defaults here: a field left out of a PATCH must stay as it is.
  const identityPatch = z.object(identityFields).partial();

  app.post("/accounts/:id/identities", async (c) => {
    const body = identityBody.parse(await c.req.json());
    return c.json(addIdentity(db, c.get("user").id, c.req.param("id"), body));
  });

  app.patch("/accounts/:id/identities/:identityId", async (c) => {
    const body = identityPatch.parse(await c.req.json());
    return c.json(updateIdentity(db, c.get("user").id, c.req.param("id"), c.req.param("identityId"), body));
  });

  app.delete("/accounts/:id/identities/:identityId", (c) => {
    removeIdentity(db, c.get("user").id, c.req.param("id"), c.req.param("identityId"));
    return c.json({ ok: true });
  });

  app.delete("/accounts/:id", async (c) => {
    const user = c.get("user");
    const acc = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    if (!acc) throw new HttpError(404, "Account not found");
    await removeAccount(acc.id);
    return c.json({ ok: true });
  });

  // ---- OAuth (Google, Microsoft) -----------------------------------------

  /** Where a failed sign-in lands. It always says which provider it was, since two buttons can start one. */
  const back = (provider: "google" | "microsoft", query: string) => `/settings/accounts?${query}&provider=${provider}`;

  const startOAuth = (provider: "google" | "microsoft") =>
    app.get(`/oauth/${provider}/start`, (c) => {
      const user = c.get("user");
      const configured = provider === "google" ? config.google.clientId : config.microsoft.clientId;
      if (!configured) return c.redirect(back(provider, `error=${provider}-not-configured`));
      const state = randomToken(24);
      const verifier = randomToken(48);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      db.run("DELETE FROM oauth_states WHERE expires_at < ?", Date.now());
      db.run(
        "INSERT INTO oauth_states (state, user_id, provider, verifier, expires_at) VALUES (?,?,?,?,?)",
        state,
        user.id,
        provider,
        verifier,
        Date.now() + 10 * 60_000,
      );
      const url = provider === "google" ? googleAuthUrl(config, state, challenge) : microsoftAuthUrl(config, state, challenge);
      return c.redirect(url);
    });

  const finishOAuth = (provider: "google" | "microsoft") =>
    app.get(`/oauth/${provider}/callback`, async (c) => {
      const user = c.get("user");
      const state = c.req.query("state") ?? "";
      const code = c.req.query("code");
      const row = db.get<{ user_id: string; verifier: string; provider: string }>(
        "SELECT user_id, verifier, provider FROM oauth_states WHERE state = ? AND expires_at > ?",
        state,
        Date.now(),
      );
      db.run("DELETE FROM oauth_states WHERE state = ?", state);
      // The state is single-use and bound to the user who started the flow.
      if (!row || row.provider !== provider || row.user_id !== user.id) return c.redirect(back(provider, "error=expired"));
      if (!code) return c.redirect(back(provider, `error=${encodeURIComponent(c.req.query("error") ?? "denied")}`));
      let result: OAuthResult;
      try {
        result = provider === "google" ? await googleExchange(config, code, row.verifier) : await microsoftExchange(config, code, row.verifier);
      } catch (err) {
        console.error(`[slipstream] ${provider} sign-in failed:`, err);
        return c.redirect(back(provider, `error=${encodeURIComponent(err instanceof Error ? err.message : "sign-in failed")}`));
      }
      await upsertAccount(user.id, provider === "google" ? "gmail" : "outlook", result.email, result.name, result.auth);
      // Local mode: OAuth for Microsoft returns on http://localhost, so hop back to the canonical origin.
      return c.redirect(`${config.publicUrl}/?connected=${provider}&provider=${provider}`);
    });

  startOAuth("google");
  startOAuth("microsoft");
  finishOAuth("google");
  finishOAuth("microsoft");

  // ---- Import (.mbox from Google Takeout / Thunderbird / Apple Mail, .eml) ---

  app.post("/import", async (c) => {
    const user = c.get("user");
    const form = await c.req.formData();
    const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
    if (files.length === 0) throw new HttpError(400, "Choose an .mbox or .eml file");
    const ownerEmail = String(form.get("email") ?? "").trim().toLowerCase();
    const dir = join(config.dataDir, "imports", newId("imp"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const saved: { path: string; name: string }[] = [];
    for (const f of files) {
      const path = join(dir, `${saved.length}`);
      await pipeline(Readable.fromWeb(f.stream() as import("node:stream/web").ReadableStream), createWriteStream(path, { mode: 0o600 }));
      saved.push({ path, name: f.name });
    }

    const label = files.length === 1 ? files[0]!.name.replace(/\.(mbox|eml|mbx)$/i, "") : `${files.length} files`;
    const accountEmail = ownerEmail || `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "archive"}@import.local`;
    const accountId = await upsertAccount(user.id, "archive", accountEmail, `Imported · ${label}`, null);
    const jobId = newId("job");

    imports.set(accountId, { jobId, imported: 0 });
    void (async () => {
      let imported = 0;
      let batch: IncomingMessage[] = [];
      let removed = false;
      const finish = () => {
        if (imports.get(accountId)?.jobId === jobId) imports.delete(accountId);
      };
      /** Stores the pending batch. False once the account is gone (removed in Settings mid-import): nothing more can be stored. */
      const flush = (): boolean => {
        const account = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId);
        if (!account) {
          removed = true;
          return false;
        }
        if (batch.length === 0) return true;
        // Emptied before storing, so a store that fails is never repeated with the same messages.
        const messages = batch;
        batch = [];
        const touched = store.ingest(account, { messages, cursor: "archive", done: true });
        imported += messages.length;
        imports.set(accountId, { jobId, imported });
        events.emitToUser(user.id, { type: "import", jobId, accountId, status: "running", imported });
        if (touched.length) events.emitToUser(user.id, { type: "threads", accountId, threadIds: touched });
        return true;
      };
      try {
        read: for (const file of saved) {
          for await (const msg of readMailFile(file.path, file.name, ownerEmail || undefined)) {
            batch.push(msg);
            // Leaving the loop closes the file, so a removed account doesn't keep a huge archive being read.
            if (batch.length >= IMPORT_BATCH && !flush()) break read;
          }
        }
        const gone = removed || !flush();
        // Stamped after the last batch, so everything imported counts as history rather than new mail.
        if (!gone) db.run("UPDATE accounts SET first_synced_at = ? WHERE id = ? AND first_synced_at IS NULL", Date.now(), accountId);
        finish();
        events.emitToUser(
          user.id,
          gone
            ? { type: "import", jobId, accountId, status: "failed", imported, error: "The account was removed while its mail was being imported." }
            : { type: "import", jobId, accountId, status: "done", imported },
        );
      } catch (err) {
        // Keep what was read before the failure. The batch is emptied before it is stored and the account is checked
        // first, so this can't repeat the store that failed; and nothing in a catch may throw.
        try {
          flush();
        } catch (flushErr) {
          console.error("[slipstream] import:", flushErr);
        }
        finish();
        events.emitToUser(user.id, { type: "import", jobId, accountId, status: "failed", imported, error: err instanceof Error ? err.message : String(err) });
      } finally {
        finish();
        rmSync(dir, { recursive: true, force: true });
      }
    })().catch((err) => console.error("[slipstream] import:", err));

    return c.json({ jobId, accountId });
  });

  return app;
}
