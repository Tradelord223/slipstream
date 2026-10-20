import { existsSync, readFileSync, statSync, statfsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { migrations } from "./db/schema.ts";
import { cacheUsage, limitBytes, type Query } from "./mail/cache.ts";
import { SecretBox } from "./lib/crypto.ts";
import { packageVersion } from "./lib/version.ts";

/**
 * `slipstream doctor`: checks an install without starting it and says, in plain words, what's wrong and how to fix it.
 * It changes nothing: the data folder isn't created, the database is opened so that no side files appear (see
 * openDatabase), no key file is created, and the one network request is to Slipstream's own health check on this machine.
 *
 *   slipstream doctor          # people
 *   slipstream doctor --json   # agents and scripts; exit code 1 when anything fails
 */

export type Status = "ok" | "warn" | "fail" | "info";

export interface Check {
  id: string;
  status: Status;
  title: string;
  detail?: string;
  fix?: string;
}

export interface DoctorReport {
  version: string;
  mode: Config["mode"];
  dataDir: string;
  checks: Check[];
  summary: { fail: number; warn: number };
}

const DAY = 86_400_000;
const LOW_DISK = 1024 ** 3;

export interface DoctorOptions {
  /** Is something answering Slipstream's health check on this port? Injected in tests. */
  health?: (url: string) => Promise<"slipstream" | "other" | "none">;
  /** Can this port be bound right now? Injected in tests. */
  portFree?: (host: string, port: number) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export async function runDoctor(config: Config, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // Node.js
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  add(
    major > 22 || (major === 22 && minor >= 18)
      ? { id: "node", status: "ok", title: `Node.js ${process.versions.node}` }
      : { id: "node", status: "fail", title: `Node.js ${process.versions.node} is too old`, fix: "Install Node.js 22.18 or newer from nodejs.org." },
  );

  // Data folder
  const shown = config.dataDir.replace(homedir(), "~");
  if (!existsSync(config.dataDir)) {
    add({ id: "data-dir", status: "info", title: "No data folder yet", detail: `${shown} is created the first time Slipstream starts.` });
  } else {
    const dirMode = statSync(config.dataDir).mode & 0o777;
    add(
      dirMode & 0o077
        ? { id: "data-dir", status: "warn", title: `Data folder ${shown} can be read by other users on this computer`, fix: `Run: chmod 700 "${config.dataDir}"` }
        : { id: "data-dir", status: "ok", title: `Data folder ${shown}, readable only by you` },
    );

    // Disk space
    try {
      const fs = statfsSync(config.dataDir);
      const free = fs.bavail * fs.bsize;
      add(
        free < LOW_DISK
          ? { id: "disk", status: "warn", title: `Only ${size(free)} free on the disk holding your mail`, fix: "Free up space. Slipstream stores new mail and attachments here." }
          : { id: "disk", status: "ok", title: `${size(free)} free on disk` },
      );
    } catch {
      add({ id: "disk", status: "info", title: "Couldn't read free disk space" });
    }
  }

  // Database
  let db: DatabaseSync | null = null;
  if (!existsSync(config.dbPath)) {
    add({ id: "database", status: "info", title: "No database yet", detail: "It's created the first time Slipstream starts." });
  } else {
    try {
      const opened = openDatabase(config.dbPath);
      db = opened.db;
      const version = (db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)?.version ?? 0;
      const ok = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check === "ok";
      // Recent writes live in the -wal file until SQLite folds them in.
      const bytes = statSync(config.dbPath).size + (existsSync(`${config.dbPath}-wal`) ? statSync(`${config.dbPath}-wal`).size : 0);
      if (!ok)
        add({ id: "database", status: "fail", title: "The database is damaged", fix: "Restore it from a backup (see docs/self-hosting.md), or move it aside and let Slipstream sync your mail again." });
      else if (version > migrations.length)
        add({ id: "database", status: "fail", title: "The database was written by a newer Slipstream", detail: `Database version ${version}, this Slipstream knows ${migrations.length}.`, fix: "Update Slipstream: npm install -g slipstream-mail@latest" });
      else if (version < migrations.length)
        add({ id: "database", status: "ok", title: `Database ${size(bytes)}, no damage found`, detail: [`It will be upgraded (version ${version} → ${migrations.length}) the next time Slipstream starts.`, opened.note].filter(Boolean).join(" ") });
      else add({ id: "database", status: "ok", title: `Database ${size(bytes)}, up to date, no damage found`, detail: opened.note });
    } catch (err) {
      add({ id: "database", status: "fail", title: "Couldn't open the database", detail: err instanceof Error ? err.message : String(err), fix: "Check that the data folder belongs to you, and that no other program has the file locked." });
      db?.close();
      db = null;
    }
  }

  // Encryption key, and whether it still opens the saved sign-ins
  const keyFile = join(config.dataDir, "secret.key");
  const fromEnv = Boolean(env.SLIPSTREAM_SECRET);
  if (!fromEnv && !existsSync(keyFile)) {
    add({ id: "key", status: "info", title: "No encryption key yet", detail: "It's created the first time Slipstream starts." });
  } else {
    if (!fromEnv && statSync(keyFile).mode & 0o077) add({ id: "key-file", status: "warn", title: "The encryption key file can be read by other users", fix: `Run: chmod 600 "${keyFile}"` });
    const sealed = db ? (db.prepare("SELECT email, auth_enc FROM accounts WHERE auth_enc IS NOT NULL LIMIT 1").get() as { email: string; auth_enc: string } | undefined) : undefined;
    let opens = true;
    if (sealed) {
      try {
        new SecretBox(config.dataDir, env.SLIPSTREAM_SECRET || undefined).open(sealed.auth_enc);
      } catch {
        opens = false;
      }
    }
    const where = fromEnv ? "from SLIPSTREAM_SECRET" : "in secret.key";
    if (!opens)
      add({
        id: "key",
        status: "fail",
        title: "The encryption key doesn't open your saved sign-ins",
        detail: `The key ${where} isn't the one they were saved with.`,
        fix: fromEnv ? "Set SLIPSTREAM_SECRET back to its earlier value, or reconnect each account in Settings → Accounts." : "Restore the earlier secret.key, or reconnect each account in Settings → Accounts.",
      });
    else if (config.mode === "team" && !fromEnv)
      add({ id: "key", status: "warn", title: "The encryption key sits next to the database", detail: "Anyone with a copy of the data folder can open the saved sign-ins.", fix: 'Set SLIPSTREAM_SECRET (for example: fly secrets set SLIPSTREAM_SECRET="$(openssl rand -base64 32)").' });
    else add({ id: "key", status: "ok", title: `Saved sign-ins are encrypted with the key ${where}` });
  }

  // Is it running?
  const base = `http://127.0.0.1:${config.port}`;
  const health = await (opts.health ?? probeHealth)(`${base}/api/health`);
  if (health === "slipstream") add({ id: "server", status: "ok", title: `Running at ${config.mode === "local" ? base : config.publicUrl}` });
  else if (health === "other")
    add({ id: "server", status: "fail", title: `Another program is using port ${config.port}`, fix: `Quit that program, or start Slipstream on another port: SLIPSTREAM_PORT=4381 slipstream` });
  else if (!(await (opts.portFree ?? portFree)(config.host, config.port)))
    add({ id: "server", status: "fail", title: `Port ${config.port} is taken, and it isn't Slipstream`, fix: `Start Slipstream on another port: SLIPSTREAM_PORT=4381 slipstream` });
  else add({ id: "server", status: "info", title: "Slipstream isn't running", detail: `Start it with \`slipstream\`; it opens at ${base}.` });

  // Team servers
  if (config.mode === "team") {
    const url = new URL(config.publicUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (loopback) add({ id: "public-url", status: "fail", title: "SLIPSTREAM_PUBLIC_URL isn't set", detail: "Sign-in links, invites and OAuth redirects would point at this machine.", fix: "Set SLIPSTREAM_PUBLIC_URL to the address people use, e.g. https://mail.example.com" });
    else if (url.protocol !== "https:") add({ id: "public-url", status: "fail", title: `${config.publicUrl} isn't https`, fix: "Serve Slipstream over https (Fly.io, Render and Railway do this for you) and update SLIPSTREAM_PUBLIC_URL." });
    else add({ id: "public-url", status: "ok", title: `Public address ${config.publicUrl}` });
    add(
      env.LITESTREAM_REPLICA_URL
        ? { id: "backups", status: "ok", title: "Continuous backups are set up (Litestream)" }
        : { id: "backups", status: "warn", title: "No backups are set up", fix: "Set LITESTREAM_REPLICA_URL and its access keys to back up to any S3-compatible bucket. See docs/self-hosting.md." },
    );
  }

  // Mail accounts and the work queue
  if (db) {
    const accounts = db
      .prepare("SELECT email, provider, sync_status, sync_error, last_synced_at FROM accounts ORDER BY created_at")
      .all() as { email: string; provider: string; sync_status: string; sync_error: string | null; last_synced_at: number | null }[];
    const real = accounts.filter((a) => a.provider !== "demo");
    if (real.length === 0) add({ id: "accounts", status: "info", title: "No mail account connected yet", detail: "Settings → Accounts connects Gmail, Outlook or any IMAP server." });
    let healthy = 0;
    for (const a of real) {
      const id = `account:${a.email}`;
      if (a.sync_status === "reauth") add({ id, status: "fail", title: `${a.email} needs you to sign in again`, detail: a.sync_error ?? undefined, fix: "In Settings → Accounts, press Reconnect next to this account." });
      else if (a.sync_status === "error") add({ id, status: "warn", title: `${a.email} couldn't sync`, detail: a.sync_error ?? undefined, fix: "It retries on its own. If the password or app password changed, press Reconnect next to this account in Settings → Accounts." });
      else if (a.provider !== "archive" && a.last_synced_at !== null && now - a.last_synced_at > DAY && health === "slipstream")
        add({ id, status: "warn", title: `${a.email} hasn't synced in ${Math.round((now - a.last_synced_at) / DAY)} days`, fix: "Press Sync now in Settings → Accounts, and check your connection." });
      else healthy++;
    }
    if (healthy) add({ id: "accounts", status: "ok", title: `${healthy === 1 ? "1 mail account" : `${healthy} mail accounts`} in good shape` });

    const failed = (db.prepare("SELECT count(*) AS n FROM pending_actions WHERE status = 'failed'").get() as { n: number }).n;
    const stuck = (db.prepare("SELECT count(*) AS n FROM pending_actions WHERE status IN ('queued','running') AND run_after < ?").get(now - 3_600_000) as { n: number }).n;
    if (failed) add({ id: "queue", status: "warn", title: `${failed === 1 ? "1 change" : `${failed} changes`} couldn't reach your mail provider`, detail: "They're applied in Slipstream but not on the provider's side.", fix: "Check Activity for the error; reconnecting the account usually clears it." });
    if (stuck) add({ id: "queue-stuck", status: "warn", title: `${stuck === 1 ? "1 change has" : `${stuck} changes have`} been waiting over an hour to reach your provider`, fix: "Make sure Slipstream is running and online; changes go out on their own." });
    // The cache of full message text, against each person's limit.
    try {
      const open = db;
      const query: Query = (sql, ...params) => open.prepare(sql).all(...params) as never;
      const users = db.prepare("SELECT DISTINCT user_id FROM accounts WHERE provider NOT IN ('demo', 'archive')").all() as { user_id: string }[];
      let used = 0;
      let allowed = 0;
      let messages = 0;
      let over = 0;
      for (const { user_id: userId } of users) {
        const usage = cacheUsage(query, join(config.dataDir, "blobs"), userId);
        const limit = limitBytes(query, userId);
        used += usage.total;
        allowed += limit;
        messages += usage.messages;
        if (usage.total > limit) over++;
      }
      if (users.length)
        add(
          over
            ? { id: "cache", status: "warn", title: `Mail cache is ${size(used)}, over its ${size(allowed)} limit`, detail: `${messages} messages are kept in full.`, fix: "Slipstream returns the oldest read mail to previews after each sync, so start it. If this stays, what is left was imported or sent from here and can't be fetched again." }
            : { id: "cache", status: "ok", title: used ? `Mail cache ${size(used)} of ${size(allowed)}` : `Mail cache is empty (limit ${size(allowed)})`, detail: `${messages} messages are kept in full; the rest are fetched when you open them.` },
        );
    } catch {
      // A database from before the cache existed has nothing to measure.
    }
    const sendFailed = (db.prepare("SELECT count(*) AS n FROM drafts WHERE status = 'failed'").get() as { n: number }).n;
    if (sendFailed) add({ id: "sends", status: "warn", title: `${sendFailed === 1 ? "1 message" : `${sendFailed} messages`} failed to send`, fix: "Open Drafts to see why and send again." });
    db.close();
  }

  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  return { version: packageVersion(), mode: config.mode, dataDir: config.dataDir, checks, summary: { fail, warn } };
}

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export function formatReport(r: DoctorReport, color = false): string {
  const paint = (s: Status, t: string) => (!color ? t : s === "ok" ? `\x1b[32m${t}\x1b[0m` : s === "warn" ? `\x1b[33m${t}\x1b[0m` : s === "fail" ? `\x1b[31m${t}\x1b[0m` : `\x1b[2m${t}\x1b[0m`);
  const lines = [`Slipstream doctor · ${r.version} · ${r.mode === "local" ? "on this computer" : "team server"}`, ""];
  for (const c of r.checks) {
    lines.push(`  ${paint(c.status, MARK[c.status])} ${c.title}`);
    if (c.detail) lines.push(`    ${c.detail}`);
    if (c.fix) lines.push(`    Fix: ${c.fix}`);
  }
  const { fail, warn } = r.summary;
  lines.push("", fail || warn ? [fail ? `${fail} problem${fail > 1 ? "s" : ""}` : "", warn ? `${warn} warning${warn > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ") + "." : "Everything looks good.");
  return lines.join("\n");
}

/**
 * Opens the database without creating or changing any file. A plain read-only open of a WAL database makes `-wal` and
 * `-shm` files when none exist, and, being read-only, never removes them, so doctor would leave them behind.
 *
 * - `-wal` and `-shm` both exist: the server is running, or crashed and left them. A plain read-only open creates
 *   nothing new, and it reads the recent changes in the WAL, so the answers are current.
 * - Otherwise nothing is running, so the file is opened immutable (`?immutable=1`): SQLite takes no locks and makes
 *   no side files. That is only safe because nothing is writing; it would be wrong against a live server, which is
 *   why that case never reaches it. The trade-off: an immutable open ignores a stray `-wal` that has no `-shm`
 *   beside it, so that case says some recent changes weren't read.
 */
function openDatabase(path: string): { db: DatabaseSync; note?: string } {
  if (existsSync(`${path}-wal`) && existsSync(`${path}-shm`)) return { db: new DatabaseSync(path, { readOnly: true }) };
  const url = pathToFileURL(path);
  url.search = "mode=ro&immutable=1";
  const wal = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
  return { db: new DatabaseSync(url.href, { readOnly: true }), note: wal > 0 ? `${size(wal)} of recent changes in the -wal file weren't read.` : undefined };
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function probeHealth(url: string): Promise<"slipstream" | "other" | "none"> {
  try {
    const res = await fetch(url, { headers: { "x-slipstream": "1" }, signal: AbortSignal.timeout(2_000) });
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.ok && body?.ok === true ? "slipstream" : "other";
  } catch {
    return "none";
  }
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}
