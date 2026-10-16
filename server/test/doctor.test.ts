import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { formatReport, runDoctor, type DoctorOptions } from "../src/doctor.ts";
import { addAccount, makeEnv } from "./helpers.ts";

const offline: DoctorOptions = { health: async () => "none", portFree: async () => true, env: {} };
const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id);

describe("slipstream doctor", () => {
  const dirs: string[] = [];
  const freshDir = () => {
    const d = mkdtempSync(join(tmpdir(), "slipstream-doctor-"));
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("a brand-new install has nothing to fix and creates nothing", async () => {
    const dir = freshDir();
    const r = await runDoctor(loadConfig({ dataDir: dir, dbPath: join(dir, "slipstream.db") }), offline);
    assert.equal(r.summary.fail, 0);
    assert.equal(byId(r, "database")!.status, "info");
    assert.equal(byId(r, "key")!.status, "info");
    assert.equal(byId(r, "server")!.status, "info");
    assert.match(formatReport(r), /Everything looks good/);
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(join(dir, "secret.key")), "doctor never creates the key");
    assert.ok(!existsSync(join(dir, "slipstream.db")), "or the database");
  });

  test("a working install with accounts in good shape", async () => {
    const env = makeEnv();
    try {
      const id = addAccount(env.ctx, LOCAL_USER_ID, "jordan@fernpoint.co", "imap");
      env.ctx.db.run("UPDATE accounts SET auth_enc = ?, last_synced_at = ? WHERE id = ?", env.ctx.secrets.seal({ password: "x" }), Date.now(), id);
      const r = await runDoctor(env.ctx.config, { ...offline, health: async () => "slipstream" });
      assert.equal(r.summary.fail, 0, formatReport(r));
      assert.equal(byId(r, "database")!.status, "ok");
      assert.match(byId(r, "database")!.title, /up to date/);
      assert.equal(byId(r, "key")!.status, "ok");
      assert.equal(byId(r, "server")!.status, "ok");
      assert.equal(byId(r, "accounts")!.title, "1 mail account in good shape");
    } finally {
      env.cleanup();
    }
  });

  test("names each broken account, stuck change and failed send, with the fix", async () => {
    const env = makeEnv();
    try {
      const a = addAccount(env.ctx, LOCAL_USER_ID, "work@fernpoint.co", "gmail");
      const b = addAccount(env.ctx, LOCAL_USER_ID, "home@fernpoint.co", "imap");
      env.ctx.db.run("UPDATE accounts SET sync_status = 'reauth', sync_error = 'Token revoked' WHERE id = ?", a);
      env.ctx.db.run("UPDATE accounts SET last_synced_at = ? WHERE id = ?", Date.now() - 3 * 86_400_000, b);
      env.ctx.db.run("INSERT INTO pending_actions (account_id, kind, payload, run_after, status, created_at) VALUES (?, 'archive', '{}', 0, 'failed', 0)", b);
      env.ctx.db.run("INSERT INTO drafts (id, user_id, account_id, status, updated_at) VALUES ('drf_x', ?, ?, 'failed', 0)", LOCAL_USER_ID, b);
      const r = await runDoctor(env.ctx.config, { ...offline, health: async () => "slipstream" });
      const reauth = byId(r, "account:work@fernpoint.co")!;
      assert.equal(reauth.status, "fail");
      assert.match(reauth.fix!, /Reconnect/);
      assert.equal(byId(r, "account:home@fernpoint.co")!.status, "warn");
      assert.match(byId(r, "account:home@fernpoint.co")!.title, /3 days/);
      assert.equal(byId(r, "queue")!.status, "warn");
      assert.equal(byId(r, "sends")!.status, "warn");
      assert.equal(r.summary.fail, 1);
      assert.match(formatReport(r), /1 problem, 3 warnings\./);
    } finally {
      env.cleanup();
    }
  });

  test("a changed key is caught before it locks you out of your accounts", async () => {
    const env = makeEnv();
    try {
      const id = addAccount(env.ctx, LOCAL_USER_ID, "jordan@fernpoint.co", "imap");
      env.ctx.db.run("UPDATE accounts SET auth_enc = ? WHERE id = ?", env.ctx.secrets.seal({ password: "x" }), id);
      const wrong = await runDoctor(env.ctx.config, { ...offline, env: { SLIPSTREAM_SECRET: "a different secret" } });
      assert.equal(byId(wrong, "key")!.status, "fail");
      assert.match(byId(wrong, "key")!.fix!, /SLIPSTREAM_SECRET back/);
      const r = await runDoctor(env.ctx.config, offline);
      assert.equal(byId(r, "key")!.status, "ok", "with the right key file it opens");
    } finally {
      env.cleanup();
    }
  });

  test("loose permissions, a taken port and another program on the port", async () => {
    const dir = freshDir();
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "secret.key"), "c2VjcmV0", { mode: 0o644 });
    chmodSync(join(dir, "secret.key"), 0o644);
    const config = loadConfig({ dataDir: dir, dbPath: join(dir, "slipstream.db") });
    const taken = await runDoctor(config, { ...offline, portFree: async () => false });
    assert.equal(byId(taken, "data-dir")!.status, "warn");
    assert.equal(byId(taken, "key-file")!.status, "warn");
    assert.equal(byId(taken, "server")!.status, "fail");
    const other = await runDoctor(config, { ...offline, health: async () => "other" });
    assert.match(byId(other, "server")!.title, /Another program/);
  });

  test("team servers need an https public address, and are told about backups and the key", async () => {
    const dir = freshDir();
    const base: Partial<Config> = { dataDir: dir, dbPath: join(dir, "slipstream.db"), mode: "team" };
    writeFileSync(join(dir, "secret.key"), "c2VjcmV0", { mode: 0o600 });
    const bare = await runDoctor(loadConfig({ ...base, publicUrl: "http://127.0.0.1:8080" }), offline);
    assert.equal(byId(bare, "public-url")!.status, "fail");
    assert.equal(byId(bare, "backups")!.status, "warn");
    assert.equal(byId(bare, "key")!.status, "warn");
    const plain = await runDoctor(loadConfig({ ...base, publicUrl: "http://mail.fernpoint.co" }), offline);
    assert.match(byId(plain, "public-url")!.title, /isn't https/);
    const good = await runDoctor(loadConfig({ ...base, publicUrl: "https://mail.fernpoint.co" }), { ...offline, env: { LITESTREAM_REPLICA_URL: "s3://bucket/slipstream", SLIPSTREAM_SECRET: "x" } });
    assert.equal(byId(good, "public-url")!.status, "ok");
    assert.equal(byId(good, "backups")!.status, "ok");
  });

  test("the CLI prints JSON for scripts and exits 1 only when something fails", () => {
    const dir = freshDir();
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    const out = execFileSync(process.execPath, [cli, "doctor", "--json"], { env: { ...process.env, SLIPSTREAM_DATA_DIR: dir, SLIPSTREAM_PORT: "4977" }, encoding: "utf8" });
    const report = JSON.parse(out) as { summary: { fail: number }; checks: { id: string }[] };
    assert.equal(report.summary.fail, 0);
    assert.ok(report.checks.some((c) => c.id === "node"));
    // A team server with no public address fails, and says so in the exit code.
    let code = 0;
    try {
      execFileSync(process.execPath, [cli, "doctor"], { env: { ...process.env, SLIPSTREAM_DATA_DIR: dir, SLIPSTREAM_PORT: "4977", SLIPSTREAM_MODE: "team", SLIPSTREAM_PUBLIC_URL: "", FLY_APP_NAME: "", RENDER_EXTERNAL_URL: "", RAILWAY_PUBLIC_DOMAIN: "" }, encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    assert.equal(code, 1);
  });
});
