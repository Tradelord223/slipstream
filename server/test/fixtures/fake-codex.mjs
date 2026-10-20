#!/usr/bin/env node
// A stand-in for the `codex` binary: records how it was called, reads the MCP settings from its -c
// overrides and SLIPSTREAM_TOKEN, calls the MCP server like the real CLI would, and streams `exec --json`
// events. Test controls via env: FAKE_LOG, FAKE_LOGGED_IN=0, FAKE_MODE=normal|hang|stubborn|fail|limit|error|toolerror.
import { appendFileSync, readdirSync } from "node:fs";
// Ignore SIGTERM before anything else, so the test can never stop us before we're stubborn.
if (process.env.FAKE_MODE === "stubborn") process.on("SIGTERM", () => {});

const argv = process.argv.slice(2);
const log = (rec) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(rec) + "\n");
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (argv[0] === "--version") {
  console.log("codex-cli 0.159.0");
  process.exit(0);
}
if (argv[0] === "features" && argv[1] === "list") {
  // Some of the switches the engine turns off, one removed feature, and no "goals", like an older Codex.
  console.log(["plugins stable true", "apps stable true", "memories stable true", "multi_agent stable true", "plugin_hooks removed false", "shell_tool stable true"].join("\n"));
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  const loggedIn = process.env.FAKE_LOGGED_IN !== "0";
  console.log(loggedIn ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(loggedIn ? 0 : 1);
}

const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (d) => (data += d));
  process.stdin.on("end", () => resolve(data));
});
// -c key=value: the value is TOML; the strings the engine sends are JSON-compatible.
const config = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const eq = argv[i + 1].indexOf("=");
  const raw = argv[i + 1].slice(eq + 1);
  config[argv[i + 1].slice(0, eq)] = JSON.parse(raw);
}
const resumeAt = argv.indexOf("resume");
const resumeId = resumeAt >= 0 ? argv.filter((a, i) => i > resumeAt && /^[0-9a-f-]{36}$/.test(a))[0] : undefined;
const mode = process.env.FAKE_MODE ?? "normal";
const token = process.env[config["mcp_servers.slipstream.bearer_token_env_var"]];
const threadId = resumeId ?? "0199a213-81c0-7800-8aa1-bbab2a035a53";

log({ bin: "codex", pid: process.pid, argv, stdin, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), config, tokenInEnv: Boolean(token) });

out({ type: "thread.started", thread_id: threadId });
out({ type: "turn.started" });

if (mode === "fail") {
  process.stderr.write(`boom: ${token} while talking to the server\n`);
  process.exit(1);
}
if (mode === "hang" || mode === "stubborn") {
  setInterval(() => {}, 1000);
} else if (mode === "error" || mode === "limit") {
  out({ type: "error", message: "Reconnecting... 1/5" });
  const message = mode === "limit" ? "You've hit your usage limit. Try again in 3 days." : "Something broke.";
  out({ type: "error", message });
  out({ type: "turn.failed", error: { message } });
  process.exit(1);
} else {
  const res = await fetch(config["mcp_servers.slipstream.url"], {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mail_search", arguments: { query: "from:ana" } } }),
  });
  const rpc = await res.json();
  const text = rpc?.result?.content?.[0]?.text ?? `HTTP ${res.status}`;
  const failed = mode === "toolerror" || res.status !== 200;
  const item = { id: "item_1", type: "mcp_tool_call", server: "slipstream", tool: "mail_search", arguments: { query: "from:ana" } };
  out({ type: "item.started", item: { ...item, status: "in_progress" } });
  out({ type: "item.completed", item: { ...item, status: failed ? "failed" : "completed", ...(failed ? { error: { message: text } } : { result: { content: [{ type: "text", text }] } }) } });
  out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: `Found: ${text}` } });
  out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } });
  process.exit(0);
}
