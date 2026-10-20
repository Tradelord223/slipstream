import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import {
  installService,
  launchAgentPlist,
  resolveProgram,
  serviceEnv,
  serviceFile,
  serviceLabel,
  servicePath,
  serviceStatus,
  systemdUnit,
  uninstallService,
  unitName,
  type Health,
  type InstallOptions,
  type Run,
} from "../src/lib/service.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");
const root = mkdtempSync(join(tmpdir(), "slipstream-service-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const dir = join(root, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** The strings inside a plist's <array>, as a plist reader would give them. */
const unxml = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const strings = (plist: string) => [...plist.matchAll(/<string>(.*?)<\/string>/g)].map((m) => unxml(m[1]!));

describe("the launch agent and systemd unit", () => {
  test("labels and unit names carry the port unless it's the default", () => {
    assert.equal(serviceLabel(4380), "com.slipstream-mail");
    assert.equal(serviceLabel(4391), "com.slipstream-mail.4391");
    assert.equal(unitName(4380), "slipstream.service");
    assert.equal(unitName(4391), "slipstream-4391.service");
    assert.equal(serviceFile(4391, "darwin", "/Users/sam"), "/Users/sam/Library/LaunchAgents/com.slipstream-mail.4391.plist");
    assert.equal(serviceFile(4380, "linux", "/home/sam"), "/home/sam/.config/systemd/user/slipstream.service");
    assert.equal(serviceFile(4380, "win32", "C:\\Users\\sam"), null);
  });

  test("the plist keeps it running at login, restarts after a crash but not a clean quit, and logs to one file", () => {
    const plist = launchAgentPlist({
      label: "com.slipstream-mail",
      program: ["/opt/homebrew/bin/node", "/opt/slipstream/bin/slipstream.js", "serve"],
      env: { SLIPSTREAM_DATA_DIR: "/Users/sam/.slipstream", PATH: "/usr/bin:/bin" },
      logPath: "/Users/sam/.slipstream/logs/server.log",
      workingDir: "/Users/sam/.slipstream",
    });
    for (const key of ["Label", "ProgramArguments", "EnvironmentVariables", "RunAtLoad", "KeepAlive", "ThrottleInterval", "StandardOutPath", "StandardErrorPath", "WorkingDirectory"]) {
      assert.match(plist, new RegExp(`<key>${key}</key>`));
    }
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
    assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
    assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/sam\/\.slipstream\/logs\/server\.log<\/string>/);
    assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/sam\/\.slipstream\/logs\/server\.log<\/string>/);
  });

  test("every string is escaped, so paths with spaces, & and quotes survive", () => {
    const tricky = `/Users/sam/Mail & "Notes" <x>/it's/node`;
    const plist = launchAgentPlist({ label: "l", program: [tricky, "a b/slipstream.js", "serve"], env: { "A&B": "<v>" }, logPath: "/l o g", workingDir: "/w" });
    assert.ok(plist.includes("Mail &amp; &quot;Notes&quot; &lt;x&gt;/it&apos;s/node"));
    assert.ok(!plist.includes(tricky));
    assert.ok(plist.includes("<key>A&amp;B</key>"));
    assert.deepEqual(strings(plist).slice(1, 4), [tricky, "a b/slipstream.js", "serve"]);
  });

  test("the unit quotes each word and escapes quotes, backslashes, % and $", () => {
    const unit = systemdUnit({
      description: "Slipstream mail",
      program: ["/usr/bin/node", "/home/sam/my apps/slipstream.js", 'say "hi" 100%', "back\\slash", "$HOME"],
      env: { SLIPSTREAM_DATA_DIR: "/home/sam/my data", PATH: "/usr/bin:/bin" },
      logPath: "/home/sam/.slipstream/logs/server.log",
    });
    assert.ok(unit.includes(String.raw`ExecStart="/usr/bin/node" "/home/sam/my apps/slipstream.js" "say \"hi\" 100%%" "back\\slash" "$$HOME"`), unit);
    assert.ok(unit.includes('Environment="SLIPSTREAM_DATA_DIR=/home/sam/my data"'));
    assert.ok(unit.includes('Environment="PATH=/usr/bin:/bin"'));
    for (const line of ["[Unit]", "Description=Slipstream mail", "[Service]", "Restart=on-failure", "RestartSec=30", "UMask=0077", "StandardOutput=append:/home/sam/.slipstream/logs/server.log", "StandardError=append:/home/sam/.slipstream/logs/server.log", "[Install]", "WantedBy=default.target"]) {
      assert.ok(unit.split("\n").includes(line), `${line} is in the unit`);
    }
  });

  test("a % in the log path is doubled, so systemd doesn't read it as a specifier", () => {
    const unit = systemdUnit({ description: "d", program: ["/n"], env: {}, logPath: "/home/sam/100%/server.log" });
    assert.ok(unit.includes("StandardOutput=append:/home/sam/100%%/server.log"));
    assert.ok(unit.includes("StandardError=append:/home/sam/100%%/server.log"));
  });

  test("a control character in any value is refused, in both formats", () => {
    const base: { program: string[]; env: Record<string, string>; logPath: string } = { program: ["/n", "serve"], env: { K: "v" }, logPath: "/l" };
    const bad: Record<string, Partial<typeof base>> = {
      "a program argument": { program: ["/n", "/Users/sam/x\ny"] },
      "an env value": { env: { K: "v\u0000" } },
      "an env name": { env: { "K\r": "v" } },
      "the log path": { logPath: "/l\u007f" },
    };
    for (const [what, change] of Object.entries(bad)) {
      assert.throws(() => launchAgentPlist({ label: "l", workingDir: "/w", ...base, ...change }), /control character/, what);
      assert.throws(() => systemdUnit({ description: "d", ...base, ...change }), /control character/, what);
    }
    assert.throws(() => launchAgentPlist({ label: "l", workingDir: "/w\t", ...base }), /control character/);
  });

  test("the service PATH drops what npx adds for its own run, keeping the order and dropping repeats", () => {
    const path = ["/opt/homebrew/bin", "/Users/sam/.npm/_npx/4d1c9f/node_modules/.bin", "/Users/sam/app/node_modules/.bin", "/usr/bin", "/opt/homebrew/bin", "", "/bin"].join(delimiter);
    assert.equal(servicePath(path), ["/opt/homebrew/bin", "/usr/bin", "/bin"].join(delimiter));
    assert.equal(servicePath(undefined), "");
  });

  test("the service PATH keeps only absolute entries, and a trailing slash doesn't hide a node_modules/.bin or a repeat", () => {
    const path = [".", "bin", "../x", "/usr/bin/", "/Users/sam/app/node_modules/.bin/", "/usr/bin", "/", "~/tools"].join(delimiter);
    assert.equal(servicePath(path), ["/usr/bin", "/"].join(delimiter));
  });

  test("the service environment carries the listed variables when set, and leaves out client settings and the rest", () => {
    const env = serviceEnv({
      SLIPSTREAM_DATA_DIR: "data/mail",
      PORT: "4391",
      SLIPSTREAM_PORT: "4392",
      SLIPSTREAM_REMOTE_PORT: "4393",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "gsecret",
      ANTHROPIC_API_KEY: "sk-secret",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      EMPTY: "",
      OPENAI_API_KEY: "",
      SLIPSTREAM_TOKEN: "t",
      SLIPSTREAM_URL: "http://x",
      SLIPSTREAM_MODE: "local",
      PATH: "/usr/bin:.",
      HOME: "/Users/sam",
      AWS_SECRET_ACCESS_KEY: "nope",
    });
    assert.deepEqual(env, {
      ANTHROPIC_API_KEY: "sk-secret",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "gsecret",
      HTTPS_PROXY: "http://proxy:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      PORT: "4391",
      SLIPSTREAM_DATA_DIR: resolve("data/mail"),
      SLIPSTREAM_PORT: "4392",
      SLIPSTREAM_REMOTE_PORT: "4393",
      https_proxy: "http://proxy:3128",
      PATH: "/usr/bin",
    });
    assert.deepEqual(serviceEnv({}), {});
  });

  test("the service environment carries where Claude Code and Codex keep their sign-ins, and what SLIPSTREAM_CLI_ENV names", () => {
    const env = serviceEnv({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", SLIPSTREAM_CLI_ENV: "MY_GATEWAY, OTHER", MY_GATEWAY: "g", UNNAMED: "u" });
    assert.deepEqual(env, { CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", MY_GATEWAY: "g", SLIPSTREAM_CLI_ENV: "MY_GATEWAY, OTHER" });
  });

  test("SLIPSTREAM_SECRET is refused, because the service can't use it yet", () => {
    assert.throws(() => serviceEnv({ SLIPSTREAM_SECRET: "s", PATH: "/usr/bin" }), /can't use SLIPSTREAM_SECRET yet.*Keep running Slipstream from a terminal for now\./);
  });
});

/** A package tree: <base>/slipstream-mail with a bin script and cli, as a checkout (cli under server/src) or a build (dist/cli.js). */
function pkg(base: string, layout: "checkout" | "build", version = "0.3.0") {
  const dir = join(base, "slipstream-mail");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slipstream-mail", version }));
  writeFileSync(join(dir, "bin", "slipstream.js"), "// bin");
  const entry = layout === "checkout" ? join(dir, "server", "src", "cli.ts") : join(dir, "dist", "cli.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  return { dir, entry };
}

/** What npx leaves in its cache: the package, a dependency and a .bin link, under an _npx folder. */
function npxCache(version = "0.3.0") {
  const cache = join(fresh("npxhome"), ".npm", "_npx", "4d1c9f", "node_modules");
  const { entry } = pkg(cache, "build", version);
  mkdirSync(join(cache, "hono"));
  writeFileSync(join(cache, "hono", "index.js"), "// dep");
  mkdirSync(join(cache, ".bin"));
  symlinkSync("../slipstream-mail/bin/slipstream.js", join(cache, ".bin", "slipstream"));
  return { cache, entry };
}

describe("the command the service runs", () => {
  const where = { path: "", realpath: (p: string) => p };
  const label = "com.slipstream-mail.4391";

  test("a checkout or global install runs its own bin script, with the node it was started with, and copies nothing", () => {
    for (const layout of ["checkout", "build"] as const) {
      const { dir, entry } = pkg(fresh(layout), layout);
      assert.deepEqual(resolveProgram(entry, "/opt/node/bin/node", fresh("data"), label, where), { program: ["/opt/node/bin/node", join(dir, "bin", "slipstream.js"), "serve"], copy: null });
    }
  });

  test("run through npx it plans a copy under the data folder, in a folder named for the service", () => {
    const { cache, entry } = npxCache("0.3.1");
    const dataDir = fresh("data");
    const dir = join(dataDir, "service", label);
    assert.deepEqual(resolveProgram(entry, "/opt/node/bin/node", dataDir, label, where), {
      program: ["/opt/node/bin/node", join(dir, "node_modules", "slipstream-mail", "bin", "slipstream.js"), "serve"],
      copy: { from: cache, dir, version: "0.3.1" },
    });
    assert.ok(!existsSync(dir), "planning copies nothing");
  });

  test("says so when the entry isn't inside a slipstream-mail package", () => {
    assert.throws(() => resolveProgram(join(fresh("lost"), "cli.js"), "/node", fresh("data"), label, where), /Couldn't find the slipstream-mail package/);
  });
});

/** A machine stand-in: records the commands, and answers `print` and `is-active` as loaded or not. */
function fakeMachine(opts: { loaded?: boolean; failing?: (call: string) => boolean } = {}) {
  const calls: string[] = [];
  let loaded = opts.loaded ?? false;
  const run: Run = (cmd, args) => {
    const call = [cmd, ...args].join(" ");
    calls.push(call);
    if (opts.failing?.(call)) return { status: 1, stdout: "", stderr: "Boot-out failed: 5: Input/output error\n" };
    if (args[0] === "print" || args.includes("is-active")) return { status: loaded ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "bootstrap" || args.includes("restart")) loaded = true;
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("installing, uninstalling and checking the service", () => {
  function setup(platform: NodeJS.Platform, extra: Partial<InstallOptions> = {}, answers: Health[] = ["none", "slipstream"]) {
    const home = fresh("home");
    const dataDir = fresh("data");
    const repo = fresh("repo");
    mkdirSync(join(repo, "bin"));
    mkdirSync(join(repo, "server", "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "slipstream-mail" }));
    writeFileSync(join(repo, "bin", "slipstream.js"), "");
    const lines: string[] = [];
    const queue = [...answers];
    const options: InstallOptions = {
      self: "slipstream",
      port: 4391,
      dataDir,
      probe: async () => (queue.length > 1 ? queue.shift()! : queue[0]!),
      log: (l) => lines.push(l),
      platform,
      home,
      uid: 501,
      entry: join(repo, "server", "src", "cli.ts"),
      execPath: "/opt/node/bin/node",
      env: { SLIPSTREAM_DATA_DIR: dataDir, PORT: "4391", PATH: "/usr/bin", OPENAI_API_KEY: "sk-x" },
      waitMs: 200,
      sleep: async () => {},
      ...extra,
    };
    return { options, home, dataDir, lines };
  }

  test("macOS: writes a plist only the user can read, loads it into launchd, and says where it is", async () => {
    const m = fakeMachine();
    const { options, home, dataDir, lines } = setup("darwin", { run: m.run });
    await installService(options);
    const file = join(home, "Library", "LaunchAgents", "com.slipstream-mail.4391.plist");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dataDir, "logs")).mode & 0o777, 0o700);
    assert.deepEqual(m.calls, ["launchctl print gui/501/com.slipstream-mail.4391", `launchctl bootstrap gui/501 ${file}`]);
    const plist = readFileSync(file, "utf8");
    const repo = dirname(dirname(dirname(options.entry)));
    assert.deepEqual(strings(plist).slice(0, 4), ["com.slipstream-mail.4391", "/opt/node/bin/node", join(repo, "bin", "slipstream.js"), "serve"]);
    assert.ok(plist.includes(`<key>PORT</key>\n    <string>4391</string>`));
    assert.ok(statSync(join(dataDir, "logs")).isDirectory());
    assert.match(lines.join("\n"), new RegExp(`will now start when you log in and restart if it stops\\.\\n  → http://127\\.0\\.0\\.1:4391\\n  logs: ${join(dataDir, "logs", "server.log").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(lines.join("\n"), /Dock icon.*Chrome.*Install.*Safari.*File → Add to Dock/);
  });

  test("macOS: installing again over a loaded service takes the old one out first", async () => {
    const m = fakeMachine({ loaded: true });
    const { options, home } = setup("darwin", { run: m.run }, ["slipstream"]);
    await installService(options);
    const file = join(home, "Library", "LaunchAgents", "com.slipstream-mail.4391.plist");
    assert.deepEqual(m.calls, ["launchctl print gui/501/com.slipstream-mail.4391", "launchctl bootout gui/501/com.slipstream-mail.4391", `launchctl bootstrap gui/501 ${file}`]);
  });

  test("macOS: a plist left behind with nothing loaded is booted out before the new one", async () => {
    const m = fakeMachine();
    const { options, home } = setup("darwin", { run: m.run });
    const file = join(home, "Library", "LaunchAgents", "com.slipstream-mail.4391.plist");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "old");
    await installService(options);
    assert.deepEqual(m.calls.slice(0, 2), ["launchctl print gui/501/com.slipstream-mail.4391", "launchctl bootout gui/501/com.slipstream-mail.4391"]);
    assert.match(readFileSync(file, "utf8"), /<plist/);
  });

  test("macOS: bootstrap is tried again while launchd finishes with the old job, and a lasting failure shows the command and its error", async () => {
    let tries = 0;
    const flaky = fakeMachine({ failing: (c) => c.includes("bootstrap") && ++tries < 3 });
    await installService(setup("darwin", { run: flaky.run }).options);
    assert.equal(flaky.calls.filter((c) => c.includes("bootstrap")).length, 3);

    const broken = fakeMachine({ failing: (c) => c.includes("bootstrap") });
    const { options, home } = setup("darwin", { run: broken.run });
    await assert.rejects(installService(options), (err: Error) => {
      const file = join(home, "Library", "LaunchAgents", "com.slipstream-mail.4391.plist");
      assert.equal(err.message, `\`launchctl bootstrap gui/501 ${file}\` failed: Boot-out failed: 5: Input/output error`);
      return true;
    });
  });

  test("it refuses when a copy started by hand holds the port, and writes nothing", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const m = fakeMachine();
      const { options, home, dataDir } = setup(platform, { run: m.run }, ["slipstream"]);
      await assert.rejects(installService(options), /Slipstream is already running at http:\/\/127\.0\.0\.1:4391, but not as a service\. Stop it \(Ctrl-C in its terminal\), then run this again\./);
      assert.ok(!existsSync(join(home, platform === "darwin" ? "Library" : ".config")));
      assert.ok(!existsSync(join(dataDir, "logs")));
      assert.equal(m.calls.length, 1, "only the question whether it is loaded");
    }
    const { options } = setup("darwin", { run: fakeMachine().run }, ["other"]);
    await assert.rejects(installService(options), /Another program is using port 4391/);
  });

  test("it says where the log is when the service never answers", async () => {
    const { options, dataDir } = setup("darwin", { run: fakeMachine().run, waitMs: 20, sleep: () => new Promise((r) => setTimeout(r, 5)) }, ["none"]);
    await assert.rejects(installService(options), (err: Error) => {
      assert.match(err.message, /hasn't answered at http:\/\/127\.0\.0\.1:4391/);
      assert.ok(err.message.includes(join(dataDir, "logs", "server.log")));
      return true;
    });
  });

  test("Linux: writes the unit, reloads systemd, enables it and restarts it", async () => {
    const m = fakeMachine();
    const { options, home } = setup("linux", { run: m.run });
    await installService(options);
    const file = join(home, ".config", "systemd", "user", "slipstream-4391.service");
    assert.match(readFileSync(file, "utf8"), /ExecStart="\/opt\/node\/bin\/node" ".*\/bin\/slipstream\.js" "serve"/);
    assert.deepEqual(m.calls, [
      "systemctl --user is-active --quiet slipstream-4391.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable slipstream-4391.service",
      "systemctl --user restart slipstream-4391.service",
    ]);
  });

  test("Linux: installing over a running unit stops it before the files change", async () => {
    const m = fakeMachine({ loaded: true });
    await installService(setup("linux", { run: m.run }, ["slipstream"]).options);
    assert.equal(m.calls[1], "systemctl --user stop slipstream-4391.service");
  });

  test("other systems are told to run it in a terminal", async () => {
    const { options } = setup("win32");
    await assert.rejects(installService(options), /Starting at login isn't supported on win32 yet\. Run `slipstream` in a terminal instead\./);
    assert.throws(() => uninstallService(options), /isn't supported on win32/);
    await assert.rejects(serviceStatus(options), /isn't supported on win32/);
  });

  test("it carries the listed settings into the file, leaves out CLI-client settings, and names the secrets it keeps (never their values)", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const env = { SLIPSTREAM_DATA_DIR: "", PORT: "4391", PATH: "/usr/bin", GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", HTTPS_PROXY: "http://proxy:3128", SLIPSTREAM_REMOTE_PORT: "4400", SLIPSTREAM_TOKEN: "cli-token" };
      const { options, home, dataDir, lines } = setup(platform, { run: fakeMachine().run });
      options.env = { ...env, SLIPSTREAM_DATA_DIR: dataDir };
      await installService(options);
      const file = serviceFile(4391, platform, home)!;
      const text = readFileSync(file, "utf8");
      for (const kept of ["client-id", "client-secret", "http://proxy:3128", "SLIPSTREAM_REMOTE_PORT", "4400"]) assert.ok(text.includes(kept), `${kept} is carried`);
      assert.ok(!text.includes("cli-token") && !text.includes("SLIPSTREAM_TOKEN"), "client settings stay out");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const out = lines.join("\n");
      assert.ok(out.includes("The service file keeps GOOGLE_CLIENT_SECRET for it; only you can read that file."), out);
      assert.ok(!out.includes("client-secret"));
    }
    const plain = setup("darwin", { run: fakeMachine().run });
    plain.options.env = { SLIPSTREAM_DATA_DIR: plain.dataDir, PATH: "/usr/bin", GOOGLE_CLIENT_ID: "id" };
    await installService(plain.options);
    assert.ok(!plain.lines.join("\n").includes("keeps"), "nothing to say without a secret");
  });

  test("it makes an existing, looser file private, and keeps its log private and from growing without end", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { options, home, dataDir } = setup(platform, { run: fakeMachine().run });
      const file = serviceFile(4391, platform, home)!;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "old", { mode: 0o644 });
      chmodSync(file, 0o644);
      mkdirSync(join(dataDir, "logs"));
      const log = join(dataDir, "logs", "server.log");
      const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
      writeFileSync(log, `${lines.join("\n")}\n`, { mode: 0o644 });
      chmodSync(log, 0o644);
      assert.ok(statSync(log).size > 5 * 1024 * 1024);
      await installService(options);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(log).mode & 0o777, 0o600);
      assert.ok(statSync(log).size <= 1024 * 1024);
      assert.ok(readFileSync(log, "utf8").endsWith(`line 199999 ${"x".repeat(30)}\n`), "the end of the log is what stays");
    }
  });

  test("Linux: the unit directory is made owner-only when it didn't exist", async () => {
    const { options, home } = setup("linux", { run: fakeMachine().run });
    await installService(options);
    assert.equal(statSync(join(home, ".config", "systemd", "user")).mode & 0o777, 0o700);
  });

  test("SLIPSTREAM_SECRET stops the install before anything changes", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const m = fakeMachine({ loaded: true });
      const { options, home, dataDir } = setup(platform, { run: m.run });
      options.env = { ...options.env, SLIPSTREAM_SECRET: "s3cret" };
      await assert.rejects(installService(options), /^Error: The start-at-login service can't use SLIPSTREAM_SECRET yet, and without it Slipstream couldn't open your saved sign-ins\. Keep running Slipstream from a terminal for now\.$/);
      assert.deepEqual(m.calls, []);
      assert.ok(!existsSync(join(home, platform === "darwin" ? "Library" : ".config")));
      assert.ok(!existsSync(join(dataDir, "logs")));
      assert.ok(!existsSync(join(dataDir, "service")));
    }
  });

  test("a port that isn't a port number is refused before it reaches a label or a path", async () => {
    for (const port of [0, -1, 65536, 4380.5, Number.NaN]) {
      const { options } = setup("darwin", { run: fakeMachine().run, port });
      await assert.rejects(installService(options), /isn't a port number/);
      assert.throws(() => uninstallService(options), /isn't a port number/);
    }
  });

  test("a value with a control character stops the install before it changes anything", async () => {
    const m = fakeMachine({ loaded: true });
    const { options, home } = setup("darwin", { run: m.run });
    options.env = { ...options.env, HTTPS_PROXY: "http://proxy\nEvil=1" };
    await assert.rejects(installService(options), /HTTPS_PROXY has a control character/);
    assert.deepEqual(m.calls, ["launchctl print gui/501/com.slipstream-mail.4391"], "only the question whether it is loaded");
    assert.ok(!existsSync(join(home, "Library")));
  });

  test("it refuses when another label's service already uses the same data folder", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const place = (home: string, port: number) => {
        const file = serviceFile(port, platform, home)!;
        mkdirSync(dirname(file), { recursive: true });
        return file;
      };
      const body = (dataDir: string | null, label: string) => {
        const env: Record<string, string> = dataDir ? { SLIPSTREAM_DATA_DIR: dataDir } : {};
        const program = ["/n", "/b", "serve"];
        return platform === "darwin" ? launchAgentPlist({ label, program, env, logPath: "/l", workingDir: "/w" }) : systemdUnit({ description: "d", program, env, logPath: "/l" });
      };

      // Names its data folder.
      let m = fakeMachine();
      let t = setup(platform, { run: m.run });
      writeFileSync(place(t.home, 4392), body(`${t.dataDir}/`, "x"));
      await assert.rejects(installService(t.options), new RegExp(`^Error: Another Slipstream service \\(${platform === "darwin" ? "com\\.slipstream-mail\\.4392" : "slipstream-4392"}\\) already uses ${t.dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Run \`slipstream service uninstall\` with PORT=4392 first\\.$`));
      assert.deepEqual(m.calls, []);
      assert.ok(!existsSync(serviceFile(4391, platform, t.home)!));

      // Has no data folder set, so it uses ~/.slipstream, which is where this one points too.
      m = fakeMachine();
      t = setup(platform, { run: m.run });
      t.options.dataDir = join(t.home, ".slipstream");
      writeFileSync(place(t.home, 4380), body(null, "d"));
      await assert.rejects(installService(t.options), /service uninstall` with PORT=4380 first\./);

      // A service on a different data folder is none of its business.
      m = fakeMachine();
      t = setup(platform, { run: m.run });
      writeFileSync(place(t.home, 4392), body(fresh("elsewhere"), "x"));
      writeFileSync(place(t.home, 4380), body(null, "d"));
      await installService(t.options);
      assert.ok(existsSync(serviceFile(4391, platform, t.home)!));
    }
  });

  test("installing again on the same label isn't a clash with itself", async () => {
    const t = setup("darwin", { run: fakeMachine({ loaded: true }).run }, ["slipstream"]);
    await installService(t.options);
    await installService(t.options);
  });

  describe("the app copy when run through npx", () => {
    const label = "com.slipstream-mail.4391";
    const copyDir = (dataDir: string) => join(dataDir, "service", label);

    test("it copies everything npx installed into a folder named for the service, with a marker, and each install replaces it", async () => {
      const { cache, entry } = npxCache("0.3.0");
      const { options, home, dataDir } = setup("darwin", { entry, run: fakeMachine().run });
      const oldLayout = join(dataDir, "app");
      mkdirSync(oldLayout, { recursive: true });
      writeFileSync(join(oldLayout, "old.txt"), "left alone");
      await installService(options);

      const dir = copyDir(dataDir);
      const bin = join(dir, "node_modules", "slipstream-mail", "bin", "slipstream.js");
      assert.ok(existsSync(bin));
      assert.ok(existsSync(join(dir, "node_modules", "hono", "index.js")), "dependencies come along");
      assert.equal(readlinkSync(join(dir, "node_modules", ".bin", "slipstream")), "../slipstream-mail/bin/slipstream.js", "links are copied as they are");
      const marker = JSON.parse(readFileSync(join(dir, ".slipstream-service.json"), "utf8"));
      assert.deepEqual({ version: marker.version, label: marker.label }, { version: "0.3.0", label });
      assert.ok(!Number.isNaN(Date.parse(marker.copiedAt)));
      assert.deepEqual(strings(readFileSync(serviceFile(4391, "darwin", home)!, "utf8")).slice(1, 4), ["/opt/node/bin/node", bin, "serve"]);
      assert.ok(existsSync(join(oldLayout, "old.txt")), "the older <dataDir>/app layout is not touched");

      // The next install replaces the copy: leftovers go, new files come in, no .next or .old stays behind.
      writeFileSync(join(dir, "stale.txt"), "old");
      writeFileSync(join(cache, "slipstream-mail", "bin", "slipstream.js"), "// newer");
      await installService({ ...options, probe: async () => "slipstream" });
      assert.ok(!existsSync(join(dir, "stale.txt")));
      assert.equal(readFileSync(bin, "utf8"), "// newer");
      assert.deepEqual(readdirSync(join(dataDir, "service")), [label]);
    });

    test("a copy that fails leaves the running service loaded and its copy intact", async () => {
      const { entry } = npxCache("0.3.0");
      const m = fakeMachine({ loaded: true });
      const { options, home, dataDir } = setup("darwin", {
        entry,
        run: m.run,
        copy: (_from, to) => {
          mkdirSync(to, { recursive: true });
          throw new Error("No space left on device");
        },
      }, ["slipstream"]);
      const file = serviceFile(4391, "darwin", home)!;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "the running service's plist");
      const dir = aCopy(dataDir, label, "0.2.0");
      await assert.rejects(installService(options), /No space left on device/);
      assert.deepEqual(m.calls, ["launchctl print gui/501/com.slipstream-mail.4391"], "never stopped");
      assert.equal(readFileSync(file, "utf8"), "the running service's plist");
      assert.equal(readFileSync(join(dir, "node_modules", "keep.txt"), "utf8"), "0.2.0");
      assert.deepEqual(readdirSync(join(dataDir, "service")), [label], "no half-made folder left");
    });

    test("a start that fails after the swap puts the old copy and the old service back, and reports the error", async () => {
      for (const platform of ["darwin", "linux"] as const) {
        const { entry } = npxCache("0.3.0");
        let failures = 0;
        const m = fakeMachine({ loaded: true, failing: (c) => (platform === "darwin" ? c.includes("bootstrap") && ++failures <= 3 : c.includes(" enable ")) });
        const { options, home, dataDir } = setup(platform, { entry, run: m.run }, ["slipstream"]);
        const file = serviceFile(4391, platform, home)!;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "the running service's file");
        const dir = aCopy(dataDir, label, "0.2.0");
        await assert.rejects(installService(options), (err: Error) => {
          assert.match(err.message, /^`(launchctl bootstrap|systemctl --user enable)[^`]*` failed: /);
          assert.match(err.message, /\nThe earlier service was put back and restarted\.$/);
          return true;
        });
        assert.equal(readFileSync(file, "utf8"), "the running service's file");
        assert.equal(readFileSync(join(dir, "node_modules", "keep.txt"), "utf8"), "0.2.0", "the old copy is back");
        assert.equal(JSON.parse(readFileSync(join(dir, ".slipstream-service.json"), "utf8")).version, "0.2.0");
        assert.deepEqual(readdirSync(join(dataDir, "service")), [label]);
        assert.match(m.calls.at(-1)!, platform === "darwin" ? /^launchctl bootstrap / : /^systemctl --user restart /, "and the old one is started again");
      }
    });

    test("an upgrade that starts but never answers goes back to the earlier copy and service", async () => {
      for (const platform of ["darwin", "linux"] as const) {
        const { entry } = npxCache("0.3.0");
        const m = fakeMachine({ loaded: true });
        const { options, home, dataDir } = setup(platform, { entry, run: m.run }, ["none"]);
        const file = serviceFile(4391, platform, home)!;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "the running service's file");
        const dir = aCopy(dataDir, label, "0.2.0");
        await assert.rejects(installService(options), (err: Error) => {
          assert.match(err.message, /hasn't answered at http:\/\/127\.0\.0\.1:4391/);
          assert.match(err.message, /\nThe earlier service was put back and restarted\.$/);
          return true;
        });
        assert.equal(readFileSync(file, "utf8"), "the running service's file");
        assert.equal(readFileSync(join(dir, "node_modules", "keep.txt"), "utf8"), "0.2.0", "the old copy is back");
        assert.deepEqual(readdirSync(join(dataDir, "service")), [label]);
      }
    });

    test("an install from a shell with another data folder refuses instead of moving the service to it", async () => {
      const m = fakeMachine({ loaded: true });
      const { options, home } = setup("darwin", { run: m.run });
      const file = serviceFile(4391, "darwin", home)!;
      mkdirSync(dirname(file), { recursive: true });
      const theirs = launchAgentPlist({ label, program: ["/n", "/b", "serve"], env: { SLIPSTREAM_DATA_DIR: "/Users/sam/Mail data" }, logPath: "/l", workingDir: "/w" });
      writeFileSync(file, theirs);
      await assert.rejects(installService(options), /uses the data folder \/Users\/sam\/Mail data\. Run this again with SLIPSTREAM_DATA_DIR=/);
      assert.equal(readFileSync(file, "utf8"), theirs);
      assert.deepEqual(m.calls.filter((c) => !c.startsWith("launchctl print")), [], "nothing was stopped or started");
    });

    test("a first install makes the log itself, private, before launchd can make it readable to others", async () => {
      const m = fakeMachine();
      const { options, dataDir } = setup("darwin", { run: m.run });
      await installService(options);
      assert.equal(statSync(join(dataDir, "logs", "server.log")).mode & 0o777, 0o600);
    });

    test("a first install that fails to start leaves nothing behind", async () => {
      const { entry } = npxCache("0.3.0");
      const m = fakeMachine({ failing: (c) => c.includes("bootstrap") });
      const { options, home, dataDir } = setup("darwin", { entry, run: m.run });
      await assert.rejects(installService(options), /launchctl bootstrap .* failed: Boot-out failed/);
      assert.ok(!existsSync(serviceFile(4391, "darwin", home)!));
      assert.ok(!existsSync(copyDir(dataDir)));
    });

    test("a folder in the way without the marker is never replaced or deleted", async () => {
      const { entry } = npxCache("0.3.0");
      const m = fakeMachine();
      const { options, dataDir } = setup("darwin", { entry, run: m.run });
      const dir = copyDir(dataDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mine.txt"), "not slipstream's");
      await assert.rejects(installService(options), /isn't a Slipstream service copy/);
      assert.equal(readFileSync(join(dir, "mine.txt"), "utf8"), "not slipstream's");
      assert.deepEqual(m.calls, ["launchctl print gui/501/com.slipstream-mail.4391"]);
    });

    test("two ports on different data folders each keep their own copy", async () => {
      const { entry } = npxCache("0.3.0");
      const a = setup("darwin", { entry, run: fakeMachine().run, port: 4391 });
      await installService(a.options);
      const b = setup("darwin", { entry, run: fakeMachine().run, port: 4392 });
      await installService(b.options);
      assert.ok(existsSync(join(a.dataDir, "service", "com.slipstream-mail.4391", ".slipstream-service.json")));
      assert.ok(existsSync(join(b.dataDir, "service", "com.slipstream-mail.4392", ".slipstream-service.json")));
    });
  });

  test("macOS: the generated plist is one plutil accepts", { skip: process.platform !== "darwin" && "plutil is macOS only" }, async () => {
    const t = setup("darwin", { run: fakeMachine().run });
    t.options.env = { ...t.options.env, HTTPS_PROXY: "http://a&b/<c>", GOOGLE_CLIENT_SECRET: "it's" };
    await installService(t.options);
    const file = serviceFile(4391, "darwin", t.home)!;
    const r = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  /** Writes a marked app copy the way an install would, with a file to tell it apart. */
  function aCopy(dataDir: string, label: string, version = "0.2.0") {
    const dir = join(dataDir, "service", label);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, ".slipstream-service.json"), JSON.stringify({ version, label, copiedAt: "2026-10-01T00:00:00.000Z" }));
    writeFileSync(join(dir, "node_modules", "keep.txt"), version);
    return dir;
  }

  test("uninstall stops the service and deletes its file and its own app copy, and says so when there was none", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const m = fakeMachine({ loaded: true });
      const { options, home, dataDir, lines } = setup(platform, { run: m.run });
      const file = serviceFile(4391, platform, home)!;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "x");
      const copy = aCopy(dataDir, serviceLabel(4391));
      uninstallService(options);
      assert.ok(!existsSync(file));
      assert.ok(!existsSync(copy));
      assert.ok(existsSync(dataDir), "the mail stays");
      assert.ok(m.calls.includes(platform === "darwin" ? "launchctl bootout gui/501/com.slipstream-mail.4391" : "systemctl --user disable --now slipstream-4391.service"), m.calls.join("\n"));
      assert.match(lines.join("\n"), /no longer starts at login/);

      const again = setup(platform, { run: fakeMachine().run });
      const spare = aCopy(again.dataDir, serviceLabel(4391));
      uninstallService(again.options);
      assert.match(again.lines.join("\n"), /wasn't set to start at login/);
      assert.ok(existsSync(spare), "a copy is only removed along with the service that used it");
    }
  });

  test("uninstalling one port's service leaves another port's copy, and never deletes a folder without the marker", () => {
    const m = fakeMachine({ loaded: true });
    const { options, home, dataDir } = setup("darwin", { run: m.run });
    const file = serviceFile(4391, "darwin", home)!;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x");
    const other = aCopy(dataDir, serviceLabel(4392));
    const unmarked = join(dataDir, "service", serviceLabel(4391));
    mkdirSync(unmarked, { recursive: true });
    writeFileSync(join(unmarked, "mine.txt"), "not slipstream's");
    const oldLayout = join(dataDir, "app");
    mkdirSync(oldLayout);
    uninstallService(options);
    assert.ok(!existsSync(file));
    assert.ok(existsSync(other), "the other port's copy stays");
    assert.ok(existsSync(join(unmarked, "mine.txt")), "no marker, no delete");
    assert.ok(existsSync(oldLayout), "the earlier <dataDir>/app layout is left alone");
  });

  test("status reports the file, whether it's loaded and whether it answers", async () => {
    const { options, home, lines } = setup("darwin", { run: fakeMachine({ loaded: true }).run }, ["slipstream"]);
    const file = serviceFile(4391, "darwin", home)!;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x");
    assert.deepEqual(await serviceStatus(options), { installed: true, loaded: true, answering: true, version: null });
    assert.deepEqual(lines, [`Starts at login: yes (${file})`, "Running as a service: yes", "Answering at http://127.0.0.1:4391: yes", `Logs: ${join(options.dataDir, "logs", "server.log")}`]);

    const none = setup("darwin", { run: fakeMachine().run }, ["none"]);
    assert.deepEqual(await serviceStatus(none.options), { installed: false, loaded: false, answering: false, version: null });
    assert.match(none.lines[0]!, /^Starts at login: no\. Turn it on with `slipstream service install`/);
  });

  test("status shows the service's version, and says to update when it's older than the one being run", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      // A real install: the program is the package's own bin script, so the version is the package.json beside it.
      const real = setup(platform, { run: fakeMachine({ loaded: true }).run, version: "0.3.0" }, ["slipstream"]);
      const pkgDir = pkg(fresh("real"), "build", "0.2.1").dir;
      const file = serviceFile(4391, platform, real.home)!;
      mkdirSync(dirname(file), { recursive: true });
      const program = ["/opt/node/bin/node", join(pkgDir, "bin", "slipstream.js"), "serve"];
      writeFileSync(file, platform === "darwin" ? launchAgentPlist({ label: "l", program, env: {}, logPath: "/l", workingDir: "/w" }) : systemdUnit({ description: "d", program, env: {}, logPath: "/l" }));
      assert.equal((await serviceStatus(real.options)).version, "0.2.1");
      assert.ok(real.lines.includes("Service version: 0.2.1"));
      assert.ok(real.lines.includes("The service runs 0.2.1; you're running 0.3.0. Run `slipstream service install` to update it."), real.lines.join("\n"));

      // A copied install: the version comes from the marker.
      const copied = setup(platform, { run: fakeMachine({ loaded: true }).run, version: "0.10.0" }, ["slipstream"]);
      const dir = aCopy(copied.dataDir, serviceLabel(4391), "0.9.0");
      const cfile = serviceFile(4391, platform, copied.home)!;
      mkdirSync(dirname(cfile), { recursive: true });
      const cprogram = ["/opt/node/bin/node", join(dir, "node_modules", "slipstream-mail", "bin", "slipstream.js"), "serve"];
      writeFileSync(cfile, platform === "darwin" ? launchAgentPlist({ label: "l", program: cprogram, env: {}, logPath: "/l", workingDir: "/w" }) : systemdUnit({ description: "d", program: cprogram, env: {}, logPath: "/l" }));
      await serviceStatus(copied.options);
      assert.ok(copied.lines.includes("The service runs 0.9.0; you're running 0.10.0. Run `slipstream service install` to update it."), "compared as numbers, not text");

      // The same or newer version says nothing.
      const same = setup(platform, { run: fakeMachine({ loaded: true }).run, version: "0.2.1" }, ["slipstream"]);
      mkdirSync(dirname(serviceFile(4391, platform, same.home)!), { recursive: true });
      writeFileSync(serviceFile(4391, platform, same.home)!, platform === "darwin" ? launchAgentPlist({ label: "l", program, env: {}, logPath: "/l", workingDir: "/w" }) : systemdUnit({ description: "d", program, env: {}, logPath: "/l" }));
      await serviceStatus(same.options);
      assert.ok(same.lines.includes("Service version: 0.2.1"));
      assert.ok(!same.lines.some((l) => l.startsWith("The service runs")));
    }
  });
});

describe("slipstream service, from the command line", { skip: process.platform !== "darwin" && process.platform !== "linux" ? `starting at login isn't supported on ${process.platform}` : false }, () => {
  const darwin = process.platform === "darwin";
  const uid = process.getuid!();

  /** A launchctl and a systemctl that log what they're asked and, for `print`/`is-active`, exit as FAKE_LOADED_EXIT says. */
  const bin = fresh("bin");
  const fake = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + "\\n");
if (a[0] === "print" || a.includes("is-active")) process.exit(Number(process.env.FAKE_LOADED_EXIT ?? 1));
if (a[0] === "bootstrap" || a.includes("restart")) fs.writeFileSync(process.env.FAKE_FLAG, "1");
`;
  for (const name of ["launchctl", "systemctl"]) {
    writeFileSync(join(bin, name), fake);
    chmodSync(join(bin, name), 0o755);
  }

  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = createNetServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });

  /** Answers /api/health on the port: always (`always`), or only once the fake launchctl/systemctl has started the service. */
  function health(port: number, flag: string, always: boolean) {
    return new Promise<Server>((resolve) => {
      const server = createServer((req, res) => {
        if (!always && !existsSync(flag)) return void req.socket.destroy();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
      server.listen(port, "127.0.0.1", () => resolve(server));
    });
  }

  async function service(args: string[], opts: { loaded?: boolean; answering?: "always" | "afterStart" | false; env?: Record<string, string>; before?: (file: string, dataDir: string) => void } = {}) {
    const home = fresh("home");
    const dataDir = join(home, "data");
    const port = await freePort();
    const log = join(home, "calls.log");
    const flag = join(home, "started");
    writeFileSync(log, "");
    const file = darwin ? join(home, "Library", "LaunchAgents", `com.slipstream-mail.${port}.plist`) : join(home, ".config", "systemd", "user", `slipstream-${port}.service`);
    opts.before?.(file, dataDir);
    const server = opts.answering ? await health(port, flag, opts.answering === "always") : null;
    const env = {
      PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
      HOME: home,
      SLIPSTREAM_DATA_DIR: dataDir,
      PORT: String(port),
      FAKE_LOG: log,
      FAKE_FLAG: flag,
      FAKE_LOADED_EXIT: opts.loaded ? "0" : "1",
      ...opts.env,
    };
    const child = spawn(process.execPath, [cliPath, "service", ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    server?.close();
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { status, stdout, stderr, calls, file, home, dataDir, port };
  }

  test("install writes the file under the user's home and starts it through launchctl or systemctl", async () => {
    const r = await service(["install"], { answering: "afterStart" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(r.file));
    const text = readFileSync(r.file, "utf8");
    assert.ok(text.includes(r.dataDir) && text.includes(String(r.port)));
    assert.ok(text.includes(join(import.meta.dirname, "..", "..", "bin", "slipstream.js")));
    if (darwin) assert.deepEqual(r.calls, [["print", `gui/${uid}/com.slipstream-mail.${r.port}`], ["bootstrap", `gui/${uid}`, r.file]]);
    else {
      const unit = `slipstream-${r.port}.service`;
      assert.deepEqual(r.calls, [["--user", "is-active", "--quiet", unit], ["--user", "daemon-reload"], ["--user", "enable", unit], ["--user", "restart", unit]]);
    }
    assert.match(r.stdout, new RegExp(`will now start when you log in and restart if it stops\\.\\n  → http://127\\.0\\.0\\.1:${r.port}\\n  logs: `));
    assert.ok(existsSync(join(r.dataDir, "logs")));
  });

  test("install over a loaded service boots the old one out first", async () => {
    const r = await service(["install"], { loaded: true, answering: "always" });
    assert.equal(r.status, 0, r.stderr);
    if (darwin) assert.deepEqual(r.calls.map((c) => c[0]), ["print", "bootout", "bootstrap"]);
    else assert.ok(r.calls.some((c) => c.includes("stop")));
  });

  test("install refuses when Slipstream is already running by hand, and changes nothing", async () => {
    const r = await service(["install"], { answering: "always" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`Slipstream is already running at http://127\\.0\\.0\\.1:${r.port}, but not as a service\\. Stop it \\(Ctrl-C in its terminal\\), then run this again\\.`));
    assert.ok(!existsSync(r.file));
    assert.equal(r.calls.length, 1);
  });

  test("uninstall stops it and removes the file", async () => {
    const r = await service(["uninstall"], {
      loaded: true,
      before: (file) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "x");
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(r.file));
    if (darwin) assert.deepEqual(r.calls.find((c) => c[0] === "bootout"), ["bootout", `gui/${uid}/com.slipstream-mail.${r.port}`]);
    else assert.ok(r.calls.some((c) => c.includes("disable") && c.includes("--now")));
  });

  test("status reports without changing anything", async () => {
    const r = await service(["status"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Starts at login: no\. Turn it on with `slipstream service install`/);
    assert.match(r.stdout, /Answering at http:\/\/127\.0\.0\.1:\d+: no/);
    assert.ok(!existsSync(r.file));
  });

  test("install refuses SLIPSTREAM_SECRET, exits 1 and changes nothing", async () => {
    const r = await service(["install"], { env: { SLIPSTREAM_SECRET: "s3cret" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /can't use SLIPSTREAM_SECRET yet.*Keep running Slipstream from a terminal for now\./);
    assert.ok(!r.stderr.includes("s3cret"));
    assert.ok(!existsSync(r.file));
    assert.ok(!existsSync(r.dataDir), "not even the data folder is made");
    assert.equal(r.calls.length, 0);
  });

  test("install keeps the file private and carries a Gmail secret across, saying so", async () => {
    const r = await service(["install"], { answering: "afterStart", env: { GOOGLE_CLIENT_SECRET: "gsecret", SLIPSTREAM_TOKEN: "t" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statSync(r.file).mode & 0o777, 0o600);
    assert.equal(statSync(r.dataDir).mode & 0o777, 0o700, "a data folder made by the install is owner-only");
    const text = readFileSync(r.file, "utf8");
    assert.ok(text.includes("gsecret") && !text.includes("SLIPSTREAM_TOKEN"));
    assert.match(r.stdout, /The service file keeps GOOGLE_CLIENT_SECRET for it; only you can read that file\./);
    assert.ok(!r.stdout.includes("gsecret"));
  });

  test("a wrong or missing action shows the usage, and team mode points at the self-hosting guide", async () => {
    for (const args of [[], ["nope"], ["install", "now"]]) {
      const r = await service(args);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Usage: slipstream service <install\|uninstall\|status>/);
      assert.equal(r.calls.length, 0);
    }
    const team = await service(["install"], { env: { SLIPSTREAM_MODE: "team" } });
    assert.equal(team.status, 1);
    assert.match(team.stderr, /docs\/self-hosting\.md/);
    assert.equal(team.calls.length, 0);
  });
});
