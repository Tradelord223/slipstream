import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { claudeCodeStdioCommand, codexStdioCommand } from "../../web/src/lib/connect.ts";
import { selfCommand } from "../src/cli.ts";
import { localCli } from "../src/http/mail.ts";
import { bridgeCli } from "../src/lib/bridge.ts";
import { serviceFile } from "../src/lib/service.ts";
import { packageVersion } from "../src/lib/version.ts";

const cliPath = join(import.meta.dirname, "..", "src", "cli.ts");
const root = mkdtempSync(join(tmpdir(), "slipstream-connect-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in for `claude` or `codex` that records its arguments and exits with FAKE_EXIT. */
function fakeAssistant(name: string) {
  const bin = join(root, name);
  const log = join(root, `${name}.log`);
  writeFileSync(bin, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(Number(process.env.FAKE_EXIT ?? 0));\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

/** Run the CLI with only the variables set here, and a data folder that must stay uncreated. */
function connect(args: string[], env: Record<string, string> = {}) {
  const dataDir = join(root, "no-data-yet");
  const res = spawnSync(process.execPath, [cliPath, "connect", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: root, SLIPSTREAM_DATA_DIR: dataDir, ...env },
    encoding: "utf8",
  });
  assert.ok(!existsSync(dataDir), "connect creates no data folder and no agent token");
  return res;
}

const here = bridgeCli(cliPath);

describe("slipstream connect", () => {
  test("claude prints the stdio command, with no token, and the same string Settings builds", () => {
    const res = connect(["claude"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), claudeCodeStdioCommand(here));
    assert.equal(res.stdout.trim(), `claude mcp add --scope user slipstream -- ${here.command} ${cliPath} mcp`);
    assert.doesNotMatch(res.stdout, /ss_agent_|Bearer/);
  });

  test("codex prints the stdio command, with no token, and the same string Settings builds", () => {
    const res = connect(["codex"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), codexStdioCommand(here));
    assert.equal(res.stdout.trim(), `codex mcp add slipstream -- ${here.command} ${cliPath} mcp`);
  });

  test("with Slipstream set to start at login, it points at the service's own copy and says so", () => {
    const home = mkdtempSync(join(root, "home-"));
    const file = serviceFile(4380, process.platform, home);
    if (!file) return; // Starting at login isn't supported on this platform.
    // The service's copy of the app, as an npx-based install leaves it under the data folder.
    const bin = join(home, "data", "service", "com.slipstream-mail.4380", "node_modules", "slipstream-mail", "bin", "slipstream.js");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      process.platform === "darwin"
        ? `<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${bin}</string><string>serve</string></array></dict></plist>`
        : `[Service]\nExecStart="/usr/bin/node" "${bin}" "serve"\n`,
    );
    const res = connect(["claude"], { HOME: home });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), claudeCodeStdioCommand(bridgeCli(bin)));
    assert.match(res.stdout, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(res.stderr, /Using the copy of Slipstream that starts at login/);
    assert.equal(localCli(4380, home)?.args[0], bin, "Settings → Connect shows the same copy");

    // The copy is gone (the service was uninstalled by hand): back to this program.
    rmSync(bin);
    assert.equal(connect(["claude"], { HOME: home }).stdout.trim(), claudeCodeStdioCommand(here));
  });

  test("the builders quote paths with spaces and fall back to the slipstream command", () => {
    const spaced = { command: "/opt/my node/bin/node", args: ["/a b/cli.js"] };
    assert.equal(claudeCodeStdioCommand(spaced), 'claude mcp add --scope user slipstream -- "/opt/my node/bin/node" "/a b/cli.js" mcp');
    assert.equal(codexStdioCommand(null), "codex mcp add slipstream -- slipstream mcp");
  });

  test("--run runs the printed command with the assistant's own binary and passes its exit code on", () => {
    const expected = {
      claude: ["mcp", "add", "--scope", "user", "slipstream", "--", here.command, cliPath, "mcp"],
      codex: ["mcp", "add", "slipstream", "--", here.command, cliPath, "mcp"],
    };
    for (const target of ["claude", "codex"] as const) {
      const { bin, log } = fakeAssistant(target);
      const env = { [target === "claude" ? "SLIPSTREAM_CLAUDE_BIN" : "SLIPSTREAM_CODEX_BIN"]: bin };
      const ok = connect([target, "--run"], env);
      assert.equal(ok.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), expected[target]);
      assert.match(ok.stdout, new RegExp(`^${target} mcp add`));
      assert.doesNotMatch(ok.stderr, /remove it first/);
      const failed = connect([target, "--run"], { ...env, FAKE_EXIT: "3" });
      assert.equal(failed.status, 3);
      assert.match(failed.stderr, /If Slipstream is already added, remove it first with `claude mcp remove slipstream --scope user` \(or `codex mcp remove slipstream`\) and run this again\./);
    }
  });

  test("--run says so plainly when the assistant isn't installed, and runs nothing", () => {
    const res = connect(["claude", "--run"], { SLIPSTREAM_CLAUDE_BIN: join(root, "not-installed") });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Claude Code isn't installed/);
  });

  test("an unknown assistant or flag shows the usage", () => {
    for (const args of [[], ["gemini"], ["claude", "--yes"]]) {
      const res = connect(args);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Usage: slipstream connect <claude\|codex> \[--run\]/);
    }
  });
});

describe("the bridge command an assistant runs", () => {
  // A machine with Homebrew's layout: node and npx are links into a versioned Cellar that the next upgrade deletes.
  const cellarNode = "/opt/homebrew/Cellar/node/26.12.0/bin/node";
  const npxScript = "/opt/homebrew/Cellar/node/26.12.0/lib/node_modules/npm/bin/npx-cli.js";
  const links: Record<string, string> = { "/opt/homebrew/bin/node": cellarNode, "/opt/homebrew/bin/npx": npxScript, [cellarNode]: cellarNode };
  const lookup = (table: Record<string, string>) => (p: string) => {
    if (!(p in table)) throw new Error(`ENOENT ${p}`);
    return table[p]!;
  };
  const where = { path: "/usr/bin:/opt/homebrew/bin", realpath: lookup(links), version: "0.2.0" };
  const npxEntry = "/Users/sam/.npm/_npx/4d1c9f/node_modules/slipstream-mail/dist/cli.js";
  const installed = "/opt/homebrew/lib/node_modules/slipstream-mail/dist/cli.js";

  test("an installed or checked-out Slipstream is started by absolute path, with the node on PATH rather than the versioned one", () => {
    assert.deepEqual(bridgeCli(installed, cellarNode, where), { command: "/opt/homebrew/bin/node", args: [installed] });
  });

  test("falls back to the running node when no PATH entry is it", () => {
    assert.deepEqual(bridgeCli(installed, cellarNode, { ...where, path: "/usr/bin:relative/bin" }), { command: cellarNode, args: [installed] });
    assert.deepEqual(bridgeCli(installed, cellarNode, { ...where, realpath: lookup({}) }), { command: cellarNode, args: [installed] });
  });

  test("run through npx, it runs npx's script with node, pinned to this version, since npm clears the cache", () => {
    const cli = bridgeCli(npxEntry, cellarNode, where);
    assert.deepEqual(cli, { command: "/opt/homebrew/bin/node", args: [npxScript, "-y", "slipstream-mail@0.2.0"] });
    assert.equal(claudeCodeStdioCommand(cli), `claude mcp add --scope user slipstream -- /opt/homebrew/bin/node ${npxScript} -y slipstream-mail@0.2.0 mcp`);
  });

  test("run through npx with no npx script to be found, it asks the PATH for npx", () => {
    const noNpx = { ...where, realpath: lookup({ "/opt/homebrew/bin/node": cellarNode, [cellarNode]: cellarNode }) };
    assert.deepEqual(bridgeCli(npxEntry, cellarNode, noNpx), { command: "npx", args: ["-y", "slipstream-mail@0.2.0"] });
    const wrapper = { ...where, realpath: lookup({ ...links, "/opt/homebrew/bin/npx": "/opt/homebrew/bin/npx" }) };
    assert.deepEqual(bridgeCli(npxEntry, cellarNode, wrapper), { command: "npx", args: ["-y", "slipstream-mail@0.2.0"] });
    assert.deepEqual(bridgeCli(npxEntry, cellarNode, { ...noNpx, version: "unknown" }), { command: "npx", args: ["-y", "slipstream-mail"] });
  });

  test("slipstream connect and Settings → Connect build the same command", () => {
    const settings = localCli(4380, root);
    assert.deepEqual(settings, bridgeCli(cliPath));
    assert.equal(claudeCodeStdioCommand(settings), connect(["claude"]).stdout.trim());
    assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  });

  test("hints name the command that works from where the program runs", () => {
    assert.equal(selfCommand(installed), "slipstream");
    assert.equal(selfCommand(npxEntry), "npx slipstream-mail");
  });
});
