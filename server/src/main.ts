import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Users } from "./auth/users.ts";
import { loadConfig, type Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { Db } from "./db/index.ts";
import { Events } from "./events.ts";
import { retireDemoMailboxes } from "./http/accounts.ts";
import { createApp } from "./http/app.ts";
import { createPublicApp, remotePort, watchRemoteOrigin } from "./http/remote.ts";
import { newId, SecretBox } from "./lib/crypto.ts";
import { Triage } from "./mail/actions.ts";
import { COMPACT_MIN_BYTES, vacuumInBackground } from "./mail/cache.ts";
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
  const ctx = { config, db, events, secrets, store, triage, users, sync, agents, commands, imports: new Map() } as AppContext;
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

/** A startup failure with a message meant for the person running Slipstream; the CLI prints it without a stack trace. */
export class StartupError extends Error {
  override name = "StartupError";
}

/** Serve `fetch` and resolve once the port is ours, or reject with the listen error (EADDRINUSE and friends). */
async function listen(fetch: (req: Request, env: unknown) => Response | Promise<Response>, hostname: string, port: number): Promise<Server> {
  const server = serve({ fetch, hostname, port }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function start(config = loadConfig()) {
  // Everything Slipstream writes is private mail data: owner-only files.
  process.umask(0o077);
  // Own the port before touching the data dir: opening the database migrates it and creates secret.key, and a second copy
  // pointed at the same data must not do that to a database a running copy is using. Until the app is ready the server
  // answers 503 to everything, /api/health included, so a health probe doesn't call a half-started copy ready.
  let app: ReturnType<typeof createApp> | undefined;
  let server: Server;
  try {
    server = await listen((req, env) => (app ? app.fetch(req, env) : Response.json({ ok: false, error: "Slipstream is starting." }, { status: 503 })), config.host, config.port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const at = config.mode === "local" ? `http://127.0.0.1:${config.port}` : `${config.host}:${config.port}`;
    throw new StartupError(
      code === "EADDRINUSE"
        ? `Slipstream is already running at ${at} (or another program is using port ${config.port}). Stop it, or set PORT to use another port.`
        : `Slipstream couldn't listen on ${at}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let ctx: AppContext;
  try {
    ctx = createContext(config);
    const here = dirname(fileURLToPath(import.meta.url));
    const staticDir = [join(here, "web"), join(here, "../../dist/web")].find((d) => existsSync(join(d, "index.html")));
    app = createApp(ctx, staticDir);
  } catch (err) {
    // The port is ours but the data isn't usable (a failed migration, a bad secret.key): let go of it rather than serve 503 forever.
    server.close();
    throw err;
  }
  if (config.mode === "local") ctx.users.ensureLocalUser();
  if (config.demo) await seedDemo(ctx);
  // A demo mailbox left from before the demo became developer-only goes once the person has real mail.
  await retireDemoMailboxes(ctx);

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
  // A database that grew while every message was downloaded in full goes back to the cache's rules, once. When that frees
  // a lot of the file, a VACUUM in a worker thread gives the space back to the disk without holding up the server.
  ctx.sync.cache
    .trimOnce({ signal: backfill.signal })
    .then(async (r) => {
      if (!r.ran) return;
      console.log(`[slipstream] mail cache: ${r.trimmed} older messages went back to previews, ${r.files} attachment files removed`);
      if (ctx.sync.cache.reclaimableBytes() >= COMPACT_MIN_BYTES) {
        await vacuumInBackground(config.dbPath);
        console.log("[slipstream] mail cache: database file compacted");
      }
    })
    .catch((err) => console.error("[slipstream] mail cache trim:", err));
  const bundleTimer = setInterval(() => {
    try {
      bundleDeliveries(ctx);
    } catch (err) {
      console.error("[slipstream] delivery bundling:", err);
    }
  }, 10_000);
  bundleTimer.unref();

  // Local mode: a loopback listener that only serves MCP + OAuth, for Tailscale Serve/Funnel or a tunnel.
  // The app works without it, so a taken port is a warning, not a reason to stop.
  const remote = config.mode === "local" ? serve({ fetch: createPublicApp(ctx).fetch, hostname: "127.0.0.1", port: remotePort(ctx) }) : null;
  remote?.on("error", (err) =>
    console.error(`[slipstream] The remote (MCP/OAuth) listener on 127.0.0.1:${remotePort(ctx)} is off: ${err.message}. Set SLIPSTREAM_REMOTE_PORT to use another port.`),
  );
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
    console.error(err instanceof StartupError ? err.message : err);
    process.exit(1);
  });
}
