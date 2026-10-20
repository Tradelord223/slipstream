import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { AppContext } from "../src/context.ts";
import { cliEngines } from "../src/agents/engines/cli.ts";
import type { Engine, EngineId } from "../src/agents/engines/types.ts";
import { fakeIO } from "./engine-io.ts";

const TOKEN = "ss_oat_0123456789abcdef";
const FIXTURES = resolve(import.meta.dirname, "fixtures");
const SEARCH_RESULT = { threads: [{ id: "thr_1", subject: "Lunch?" }] };

let mcp: Server;
let mcpUrl: string;
let mcpCalls: { auth: string | undefined; body: { method?: string; params?: { name?: string } } }[] = [];
let dir: string;
let logPath: string;

before(async () => {
  mcp = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      mcpCalls.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end("{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(SEARCH_RESULT) }] } }));
    });
  });
  await new Promise<void>((ok) => mcp.listen(0, "127.0.0.1", ok));
  mcpUrl = `http://127.0.0.1:${(mcp.address() as { port: number }).port}/mcp`;
});

after(() => void mcp.close());

const ENV_KEYS = ["SLIPSTREAM_CLAUDE_BIN", "SLIPSTREAM_CODEX_BIN", "FAKE_LOG", "FAKE_MODE", "FAKE_LOGGED_IN"];

function setup(env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), "slipstream-cli-test-"));
  logPath = join(dir, "log.jsonl");
  mcpCalls = [];
  process.env.SLIPSTREAM_CLAUDE_BIN = join(FIXTURES, "fake-claude.mjs");
  process.env.SLIPSTREAM_CODEX_BIN = join(FIXTURES, "fake-codex.mjs");
  process.env.FAKE_LOG = logPath;
  Object.assign(process.env, env);
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The fakes take their instructions from these; Slipstream passes only what it's told to.
process.env.SLIPSTREAM_CLI_ENV = "FAKE_LOG,FAKE_MODE,FAKE_LOGGED_IN";
const dataDir = mkdtempSync(join(tmpdir(), "slipstream-cli-data-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));

function engine(id: EngineId, mode: "local" | "team" = "local"): Engine {
  const e = cliEngines({ config: { mode, dataDir } } as unknown as AppContext).find((x) => x.id === id);
  assert.ok(e);
  return e;
}

interface Rec {
  bin: string;
  pid: number;
  argv: string[];
  stdin: string;
  cwd: string;
  cwdEntries: string[];
  mcpConfig?: { mcpServers: { slipstream: { type: string; url: string; headers: { Authorization: string } } } };
  mcpFileMode?: number;
  cwdMode?: number;
  config?: { [key: string]: unknown };
  tokenInEnv: boolean;
}

function records(): Rec[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Claude Code engine", () => {
  it("runs a turn through MCP, reports what happened, and resumes on the next turn", async () => {
    setup();
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    const e = engine("cli:claude-code");

    assert.deepEqual(await e.turn(io, "Find Ana's mail"), { outcome: "done" });
    assert.deepEqual(io.said, ["Let me look.", `Found: ${JSON.stringify(SEARCH_RESULT)}`]);
    assert.deepEqual(io.toolLines, [{ name: "mail_search", failed: false }]);
    assert.deepEqual(io.state, { sessionId: "11111111-2222-4333-8444-555555555555" });
    assert.equal(io.cents, 0, "plan billing adds no cost");
    assert.equal(mcpCalls.length, 1);
    assert.equal(mcpCalls[0].auth, `Bearer ${TOKEN}`);
    assert.equal(mcpCalls[0].body.method, "tools/call");
    assert.equal(mcpCalls[0].body.params?.name, "mail_search");

    const [first] = records();
    assert.equal(first.stdin, "Find Ana's mail", "the prompt goes on stdin");
    assert.ok(!first.argv.includes("--resume"));

    io.said.length = 0;
    assert.deepEqual(await e.turn(io, "And Bob's"), { outcome: "done" });
    const second = records()[1];
    assert.equal(second.argv[second.argv.indexOf("--resume") + 1], "11111111-2222-4333-8444-555555555555");
    assert.equal(second.stdin, "And Bob's");
  });

  it("locks the CLI down to Slipstream's tools and keeps the token off argv", async () => {
    setup();
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN }, model: "sonnet" });
    await engine("cli:claude-code").turn(io, "hi");
    const r = records()[0];
    const flag = (name: string) => r.argv[r.argv.indexOf(name) + 1];

    assert.ok(r.argv.includes("-p"));
    assert.equal(flag("--output-format"), "stream-json");
    assert.ok(r.argv.includes("--verbose"));
    assert.ok(r.argv.includes("--strict-mcp-config"));
    assert.equal(flag("--tools"), "", "built-in tools are off");
    assert.equal(flag("--allowedTools"), "mcp__slipstream__*");
    assert.equal(flag("--permission-mode"), "dontAsk");
    assert.equal(flag("--setting-sources"), "project,local");
    assert.equal(flag("--max-turns"), "25");
    assert.equal(flag("--append-system-prompt"), io.systemPrompt);
    assert.equal(flag("--model"), "sonnet");
    assert.ok(!r.argv.some((a) => a.includes(TOKEN)), "no token on argv");
    assert.ok(!r.tokenInEnv, "the token is only in the MCP config file");

    assert.deepEqual(r.mcpConfig, { mcpServers: { slipstream: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    assert.equal(r.mcpFileMode, 0o600);
    assert.equal(r.cwdMode, 0o700);
    assert.ok(!existsSync(r.cwd), "the private working folder is gone after the turn");
  });

  it("passes no model flag when the run has no model", async () => {
    setup();
    await engine("cli:claude-code").turn(fakeIO({ mcp: { url: mcpUrl, token: TOKEN } }), "hi");
    assert.ok(!records()[0].argv.includes("--model"));
  });

  it("marks a failed tool call", async () => {
    setup({ FAKE_MODE: "toolerror" });
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    await engine("cli:claude-code").turn(io, "hi");
    assert.deepEqual(io.toolLines, [{ name: "mail_search", failed: true }]);
  });

  it("pauses at the turn limit (a follow-up continues) and maps plan limits to the limit outcome", async () => {
    setup({ FAKE_MODE: "maxturns" });
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    assert.equal((await engine("cli:claude-code").turn(io, "hi")).outcome, "done");
    assert.match(io.notes.join(" "), /Paused after 25 turns/);
    process.env.FAKE_MODE = "limit";
    const out = await engine("cli:claude-code").turn(io, "hi");
    assert.equal(out.outcome, "limit");
    assert.match(out.outcome === "limit" ? out.error : "", /hit your limit/);
  });

  it("fails with the last of stderr, token redacted, when the CLI dies", async () => {
    setup({ FAKE_MODE: "fail" });
    const out = await engine("cli:claude-code").turn(fakeIO({ mcp: { url: mcpUrl, token: TOKEN } }), "hi");
    assert.equal(out.outcome, "failed");
    const error = out.outcome === "failed" ? out.error : "";
    assert.match(error, /exit 1/);
    assert.match(error, /boom/);
    assert.ok(!error.includes(TOKEN));
  });

  it("kills the child on abort", async () => {
    setup({ FAKE_MODE: "hang" });
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    const turn = engine("cli:claude-code").turn(io, "hi");
    const { pid } = await until(() => records()[0]);
    assert.ok(alive(pid));
    io.abort();
    const out = await turn;
    assert.equal(out.outcome, "failed");
    assert.ok(!alive(pid));
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    setup({ FAKE_MODE: "stubborn" });
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    const turn = engine("cli:claude-code").turn(io, "hi");
    const { pid } = await until(() => records()[0]);
    const started = Date.now();
    io.abort();
    await turn;
    assert.ok(Date.now() - started >= 2500, "waited for the grace period");
    assert.ok(!alive(pid));
  });
});

describe("Codex engine", () => {
  it("runs a turn through MCP, reports what happened, and resumes the thread on the next turn", async () => {
    setup();
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    const e = engine("cli:codex");

    assert.deepEqual(await e.turn(io, "Find Ana's mail"), { outcome: "done" });
    assert.deepEqual(io.said, [`Found: ${JSON.stringify(SEARCH_RESULT)}`]);
    assert.deepEqual(io.toolLines, [{ name: "mail_search", failed: false }]);
    assert.deepEqual(io.state, { threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
    assert.equal(mcpCalls.length, 1);
    assert.equal(mcpCalls[0].auth, `Bearer ${TOKEN}`);

    const first = records()[0];
    assert.equal(first.stdin, "Find Ana's mail");
    assert.ok(!first.argv.includes("resume"));
    assert.equal(first.argv.at(-1), "-");

    assert.deepEqual(await e.turn(io, "And Bob's"), { outcome: "done" });
    const second = records()[1];
    const at = second.argv.indexOf("resume");
    assert.ok(at > 0);
    assert.deepEqual(second.argv.slice(-2), ["0199a213-81c0-7800-8aa1-bbab2a035a53", "-"]);
    assert.equal(second.argv[second.argv.indexOf("-s") + 1], "read-only");
    assert.equal(second.stdin, "And Bob's");
    assert.equal(second.config?.["sandbox_mode"], "read-only", "a resumed turn is locked down too");
  });

  it("runs read-only in an empty private folder with only Slipstream's MCP server, token off argv", async () => {
    setup();
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN }, model: "gpt-5.5" });
    await engine("cli:codex").turn(io, "hi");
    const r = records()[0];
    const flag = (name: string) => r.argv[r.argv.indexOf(name) + 1];

    assert.equal(r.argv[0], "exec");
    assert.ok(r.argv.includes("--json"));
    assert.equal(flag("-s"), "read-only");
    assert.ok(r.argv.includes("--skip-git-repo-check"));
    assert.ok(r.argv.includes("--ignore-user-config"), "the person's other MCP servers and instructions stay out");
    for (const feature of ["shell_tool", "unified_exec", "hooks"]) assert.ok(r.argv.join(" ").includes(`--disable ${feature}`), `${feature} is off`);
    // Plugin and app MCP servers, memories and sub-agents are off too, but only features this Codex lists:
    // it refuses an unknown name, and a removed one can't be switched.
    for (const feature of ["plugins", "apps", "memories", "multi_agent"]) assert.ok(r.argv.join(" ").includes(`--disable ${feature}`), `${feature} is off`);
    for (const feature of ["goals", "plugin_hooks"]) assert.ok(!r.argv.join(" ").includes(`--disable ${feature}`), `${feature} isn't passed`);
    assert.ok(r.argv.includes("--ignore-rules"));
    assert.equal(flag("-m"), "gpt-5.5");
    assert.equal(resolveReal(flag("-C")), resolveReal(r.cwd));
    assert.deepEqual(r.cwdEntries, [], "the working folder is empty");
    assert.ok(!existsSync(r.cwd));

    assert.equal(r.config?.["sandbox_mode"], "read-only");
    assert.equal(r.config?.["approval_policy"], "never");
    assert.equal(r.config?.["developer_instructions"], io.systemPrompt);
    assert.equal(r.config?.["mcp_servers.slipstream.url"], mcpUrl);
    assert.equal(r.config?.["mcp_servers.slipstream.bearer_token_env_var"], "SLIPSTREAM_TOKEN");
    assert.ok(r.tokenInEnv, "the token reaches the child through its environment");
    assert.ok(!r.argv.some((a) => a.includes(TOKEN)), "no token on argv");
  });

  it("marks a failed tool call", async () => {
    setup({ FAKE_MODE: "toolerror" });
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    await engine("cli:codex").turn(io, "hi");
    assert.deepEqual(io.toolLines, [{ name: "mail_search", failed: true }]);
  });

  it("fails on turn.failed, ignoring transient errors, and maps usage limits", async () => {
    setup({ FAKE_MODE: "error" });
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    assert.deepEqual(await engine("cli:codex").turn(io, "hi"), { outcome: "failed", error: "Something broke." });
    process.env.FAKE_MODE = "limit";
    const out = await engine("cli:codex").turn(io, "hi");
    assert.equal(out.outcome, "limit");
    assert.match(out.outcome === "limit" ? out.error : "", /usage limit/);
  });

  it("fails with the last of stderr, token redacted, when the CLI dies", async () => {
    setup({ FAKE_MODE: "fail" });
    const out = await engine("cli:codex").turn(fakeIO({ mcp: { url: mcpUrl, token: TOKEN } }), "hi");
    assert.equal(out.outcome, "failed");
    const error = out.outcome === "failed" ? out.error : "";
    assert.match(error, /boom/);
    assert.ok(!error.includes(TOKEN));
  });

  it("kills the child on abort", async () => {
    setup({ FAKE_MODE: "hang" });
    const io = fakeIO({ mcp: { url: mcpUrl, token: TOKEN } });
    const turn = engine("cli:codex").turn(io, "hi");
    const { pid } = await until(() => records()[0]);
    io.abort();
    assert.equal((await turn).outcome, "failed");
    assert.ok(!alive(pid));
  });
});

/** macOS reports /var/folders as /private/var/folders. */
const resolveReal = (p: string) => p.replace(/^\/private/, "");

describe("CLI engine status", () => {
  it("is not ready in team mode", async () => {
    setup();
    for (const id of ["cli:claude-code", "cli:codex"] as const) {
      const s = await engine(id, "team").status("usr_test");
      assert.equal(s.ready, false);
      assert.equal(s.detail, "Available when Slipstream runs on your own computer.");
      assert.equal(s.kind, "cli");
      assert.equal(s.billing, "plan");
    }
  });

  it("needs install when the binary is missing", async () => {
    setup({ SLIPSTREAM_CLAUDE_BIN: join(dir, "nope"), SLIPSTREAM_CODEX_BIN: join(dir, "nope") });
    const claude = await engine("cli:claude-code").status("usr_test");
    assert.equal(claude.ready, false);
    assert.equal(claude.needs, "install");
    assert.match(claude.detail, /claude\.ai\/install\.sh/);
    const codex = await engine("cli:codex").status("usr_test");
    assert.equal(codex.needs, "install");
    assert.match(codex.detail, /@openai\/codex/);
    assert.equal((await engine("cli:codex").turn(fakeIO({}), "hi")).outcome, "failed");
  });

  it("needs login when not signed in", async () => {
    setup({ FAKE_LOGGED_IN: "0" });
    const codex = await engine("cli:codex").status("usr_test");
    assert.equal(codex.ready, false);
    assert.equal(codex.needs, "login");
    assert.match(codex.detail, /codex login/);
    const claude = await engine("cli:claude-code").status("usr_test");
    assert.equal(claude.needs, "login");
    assert.match(claude.detail, /claude/);
  });

  it("is ready when signed in, and caches the answer for a minute", async () => {
    setup();
    const codex = engine("cli:codex");
    const ready = await codex.status("usr_test");
    assert.equal(ready.ready, true);
    assert.equal(ready.detail, "Logged in using ChatGPT");
    assert.equal(ready.needs, undefined);
    assert.match(ready.note ?? "", /shell, hooks/);

    process.env.FAKE_LOGGED_IN = "0";
    assert.equal((await codex.status("usr_test")).ready, true, "served from the cache");
    assert.equal((await engine("cli:codex").status("usr_test")).ready, false, "a fresh engine probes again");

    delete process.env.FAKE_LOGGED_IN;
    const claude = await engine("cli:claude-code").status("usr_test");
    assert.equal(claude.ready, true);
    assert.match(claude.detail, /ana@fernpoint\.co/);
    assert.match(claude.note ?? "", /code\.claude\.com\/docs\/en\/legal-and-compliance/);
  });
});
