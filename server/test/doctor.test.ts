import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { loadConfig, readConfig, type Config } from "../src/config.ts";
import { Db } from "../src/db/index.ts";
import { formatReport, runDoctor, type DoctorOptions } from "../src/doctor.ts";
import { addAccount, makeEnv } from "./helpers.ts";

const offline: DoctorOptions = { health: async () => "none", portFree: async () => true, env: {}, platform: "darwin", home: join(tmpdir(), "slipstream-doctor-no-home") };
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

  test("with no data folder it says so and does not create one", async () => {
    const parent = freshDir();
    const dir = join(parent, "not-yet");
    const r = await runDoctor(readConfig({ dataDir: dir, dbPath: join(dir, "slipstream.db") }), offline);
    assert.equal(byId(r, "data-dir")!.status, "info");
    assert.equal(byId(r, "data-dir")!.title, "No data folder yet");
    assert.equal(r.summary.fail, 0);
    assert.ok(!existsSync(dir), "doctor never creates the data folder");
    assert.deepEqual(readdirSync(parent), []);
  });

  test("checking a stopped install with a WAL database leaves no side files", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "slipstream.db");
    const db = new Db(dbPath);
    db.close(); // the last connection closing folds the WAL in and removes -wal and -shm
    assert.deepEqual(readdirSync(dir), ["slipstream.db"]);
    const r = await runDoctor(readConfig({ dataDir: dir, dbPath }), offline);
    assert.equal(byId(r, "database")!.status, "ok", formatReport(r));
    assert.match(byId(r, "database")!.title, /up to date, no damage found/);
    assert.deepEqual(readdirSync(dir), ["slipstream.db"], "no -wal or -shm appeared");
  });

  test("after a crash, the leftover WAL is read and left exactly as it was", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "slipstream.db");
    // A process that writes an account and is killed before it can fold the WAL in.
    const script = join(freshDir(), "crash.ts");
    writeFileSync(
      script,
      `import { Db } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "db", "index.ts"))};
       const db = new Db(process.argv[2]);
       db.run("INSERT INTO users (id, email, name, created_at) VALUES ('usr_x', 'x@example.test', 'X', 0)");
       db.run("INSERT INTO accounts (id, user_id, provider, email, created_at) VALUES ('acc_x', 'usr_x', 'imap', 'crash@example.test', 0)");
       process.kill(process.pid, "SIGKILL");`,
    );
    try {
      execFileSync(process.execPath, [script, dbPath], { stdio: "pipe" });
    } catch {
      /* killed on purpose */
    }
    const before = readdirSync(dir).sort();
    assert.ok(before.includes("slipstream.db-wal") && before.includes("slipstream.db-shm"), `the crash left its side files: ${before}`);
    const walSize = statSync(`${dbPath}-wal`).size;
    const r = await runDoctor(readConfig({ dataDir: dir, dbPath }), offline);
    assert.equal(byId(r, "accounts")!.title, "1 mail account in good shape", "the account that lives only in the WAL is seen");
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.equal(statSync(`${dbPath}-wal`).size, walSize);
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

  test("says whether it starts at login, from the launch agent or unit for this port", async () => {
    const home = freshDir();
    const dir = freshDir();
    const config = readConfig({ dataDir: dir, dbPath: join(dir, "slipstream.db"), port: 4391 });
    const without = await runDoctor(config, { ...offline, home });
    assert.equal(byId(without, "service")!.status, "info");
    assert.equal(byId(without, "service")!.title, "Doesn't start at login");
    assert.equal(byId(without, "service")!.fix, "Run: slipstream service install");
    assert.equal(without.summary.fail + without.summary.warn, 0);

    for (const [platform, file] of [
      ["darwin", join(home, "Library", "LaunchAgents", "com.slipstream-mail.4391.plist")],
      ["linux", join(home, ".config", "systemd", "user", "slipstream-4391.service")],
    ] as const) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "x");
      const r = await runDoctor(config, { ...offline, home, platform });
      assert.equal(byId(r, "service")!.title, "Starts at login");
      assert.equal(byId(r, "service")!.fix, undefined);
    }
    // Nowhere to put one on other systems, and team servers run under Docker or systemd themselves.
    assert.equal(byId(await runDoctor(config, { ...offline, home, platform: "win32" }), "service"), undefined);
    assert.equal(byId(await runDoctor({ ...config, mode: "team", publicUrl: "https://mail.fernpoint.co" }, { ...offline, home }), "service"), undefined);
  });

  test("the CLI prints JSON for scripts and exits 1 only when something fails, and creates nothing", async () => {
    // A data folder that doesn't exist yet: running doctor must not make it.
    const dir = join(freshDir(), "no-folder-yet");
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    // A port nobody holds right now, and only the variables this test sets: nothing from the machine running the tests.
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, SLIPSTREAM_DATA_DIR: dir, SLIPSTREAM_PORT: String(port) };
    const out = execFileSync(process.execPath, [cli, "doctor", "--json"], { env, encoding: "utf8" });
    const report = JSON.parse(out) as { summary: { fail: number }; checks: { id: string }[] };
    assert.equal(report.summary.fail, 0);
    assert.ok(report.checks.some((c) => c.id === "node"));
    // A team server with no public address fails, and says so in the exit code.
    let code = 0;
    try {
      execFileSync(process.execPath, [cli, "doctor"], { env: { ...env, SLIPSTREAM_MODE: "team" }, encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    assert.equal(code, 1);
    assert.ok(!existsSync(dir), "neither run created the data folder");
  });
});
