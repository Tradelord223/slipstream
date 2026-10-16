import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Users } from "./auth/users.ts";
import { loadConfig, type Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { Db } from "./db/index.ts";
import { Events } from "./events.ts";
import { createApp } from "./http/app.ts";
import { createPublicApp, remotePort, watchRemoteOrigin } from "./http/remote.ts";
import { newId, SecretBox } from "./lib/crypto.ts";
import { Triage } from "./mail/actions.ts";
import { SenderLogos } from "./mail/logos.ts";
import { MailStore } from "./mail/store.ts";
import { SyncEngine } from "./mail/sync.ts";
import { DEMO_IDENTITY } from "./providers/demo.ts";
import { Agents } from "./agents/agents.ts";
import { Webhooks } from "./agents/webhooks.ts";
import { CloudAgent } from "./agents/cloud.ts";
import { Autopilot } from "./agents/autopilot.ts";
import { runRules } from "./mail/labels.ts";
import { backfillSenderDomains, backfillSignals, bundleDeliveries } from "./mail/signal-jobs.ts";
import { buildCatalog } from "./commands/catalog.ts";
import { Commands } from "./commands/service.ts";

export function createContext(config: Config): AppContext {
  const db = new Db(config.dbPath);
  const events = new Events();
  const secrets = new SecretBox(config.dataDir);
  const store = new MailStore(db, config.dataDir);
  const triage = new Triage(db, store);
  const users = new Users(db);
  const sync = new SyncEngine(config, db, store, events, secrets);
  const agents = new Agents(db);
  const commands = new Commands(buildCatalog());
  const ctx = { config, db, events, secrets, store, triage, users, sync, agents, commands } as AppContext;
  ctx.webhooks = new Webhooks(ctx);
  ctx.cloud = new CloudAgent(ctx);
  ctx.autopilot = new Autopilot(ctx);
  ctx.logos = new SenderLogos(ctx);
  commands.bind(ctx);
  return ctx;
}

/** First local run: a demo mailbox so there's something to fly through before connecting real mail. */
async function seedDemo(ctx: AppContext): Promise<void> {
  const userId = ctx.users.ensureLocalUser().id;
  const seeded = ctx.db.get("SELECT 1 AS x FROM settings WHERE user_id = ? AND key = 'demoSeeded'", userId);
  if (seeded) return;
  const id = newId("acc");
  ctx.db.run(
    "INSERT INTO accounts (id, user_id, provider, email, name, color, created_at) VALUES (?,?,?,?,?,?,?)",
    id,
    userId,
    "demo",
    DEMO_IDENTITY.email,
    DEMO_IDENTITY.name,
    "#5EE6C7",
    Date.now(),
  );
  ctx.db.run("INSERT INTO settings (user_id, key, value) VALUES (?, 'demoSeeded', 'true')", userId);
  await ctx.sync.syncAccount(id);
  // One reminder comes back a couple of minutes in, so Remind Me is something you see happen.
  const marco = ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE account_id = ? AND remote_id = 'marco'", id);
  if (marco) ctx.db.run("UPDATE threads SET snoozed_until = ? WHERE id = ?", Date.now() + 2 * 60_000, marco.id);
}

export async function start(config = loadConfig()) {
  // Everything Slipstream writes is private mail data: owner-only files.
  process.umask(0o077);
  const ctx = createContext(config);
  if (config.mode === "local") ctx.users.ensureLocalUser();
  if (config.demo) await seedDemo(ctx);

  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = [join(here, "web"), join(here, "../../dist/web")].find((d) => existsSync(join(d, "index.html")));
  const app = createApp(ctx, staticDir);
  ctx.sync.start();
  ctx.webhooks.start();
  ctx.cloud.startScheduler();
  ctx.autopilot.start();
  // Auto-label rules: new mail is labelled within a few seconds of arriving.
  const rulesTimer = setInterval(() => {
    try {
      runRules(ctx);
    } catch (err) {
      console.error("[slipstream] label rules:", err);
    }
  }, 5_000);
  rulesTimer.unref();
  // Everyday signals: scan mail from before they existed, then keep delivery updates tidy as new ones arrive.
  const backfill = new AbortController();
  backfillSignals(ctx, { signal: backfill.signal }).catch((err) => console.error("[slipstream] signals backfill:", err));
  backfillSenderDomains(ctx, { signal: backfill.signal }).catch((err) => console.error("[slipstream] sender domain backfill:", err));
  const bundleTimer = setInterval(() => {
    try {
      bundleDeliveries(ctx);
    } catch (err) {
      console.error("[slipstream] delivery bundling:", err);
    }
  }, 10_000);
  bundleTimer.unref();

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  // Local mode: a loopback listener that only serves MCP + OAuth, for Tailscale Serve/Funnel or a tunnel.
  const remote = config.mode === "local" ? serve({ fetch: createPublicApp(ctx).fetch, hostname: "127.0.0.1", port: remotePort(ctx) }) : null;
  const stopWatching = watchRemoteOrigin(ctx);
  const where = config.mode === "local" ? `http://127.0.0.1:${config.port}` : config.publicUrl;
  console.log(`\n  Slipstream is running (${config.mode} mode)\n  → ${where}\n  data: ${config.dataDir}\n`);

  const shutdown = async () => {
    server.close();
    remote?.close();
    stopWatching();
    ctx.webhooks.close();
    ctx.cloud.close();
    ctx.autopilot.close();
    ctx.logos.close();
    clearInterval(rulesTimer);
    clearInterval(bundleTimer);
    backfill.abort();
    await ctx.sync.stop();
    ctx.db.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { ctx, app, server };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
