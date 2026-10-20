import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { claudeCodeStdioCommand, codexStdioCommand } from "../../web/src/lib/connect.ts";

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

const here = { command: process.execPath, args: [cliPath] };

describe("slipstream connect", () => {
  test("claude prints the stdio command, with no token, and the same string Settings builds", () => {
    const res = connect(["claude"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), claudeCodeStdioCommand(here));
    assert.equal(res.stdout.trim(), `claude mcp add --scope user slipstream -- ${process.execPath} ${cliPath} mcp`);
    assert.doesNotMatch(res.stdout, /ss_agent_|Bearer/);
  });

  test("codex prints the stdio command, with no token, and the same string Settings builds", () => {
    const res = connect(["codex"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), codexStdioCommand(here));
    assert.equal(res.stdout.trim(), `codex mcp add slipstream -- ${process.execPath} ${cliPath} mcp`);
  });

  test("the builders quote paths with spaces and fall back to the slipstream command", () => {
    const spaced = { command: "/opt/my node/bin/node", args: ["/a b/cli.js"] };
    assert.equal(claudeCodeStdioCommand(spaced), 'claude mcp add --scope user slipstream -- "/opt/my node/bin/node" "/a b/cli.js" mcp');
    assert.equal(codexStdioCommand(null), "codex mcp add slipstream -- slipstream mcp");
  });

  test("--run runs the printed command with the assistant's own binary and passes its exit code on", () => {
    const expected = {
      claude: ["mcp", "add", "--scope", "user", "slipstream", "--", process.execPath, cliPath, "mcp"],
      codex: ["mcp", "add", "slipstream", "--", process.execPath, cliPath, "mcp"],
    };
    for (const target of ["claude", "codex"] as const) {
      const { bin, log } = fakeAssistant(target);
      const env = { [target === "claude" ? "SLIPSTREAM_CLAUDE_BIN" : "SLIPSTREAM_CODEX_BIN"]: bin };
      const ok = connect([target, "--run"], env);
      assert.equal(ok.status, 0);
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), expected[target]);
      assert.match(ok.stdout, new RegExp(`^${target} mcp add`));
      const failed = connect([target, "--run"], { ...env, FAKE_EXIT: "3" });
      assert.equal(failed.status, 3);
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
