#!/usr/bin/env node
// A stand-in for the `claude` binary: records how it was called, reads its MCP config, calls the MCP
// server like the real CLI would, and streams `--output-format stream-json` lines. Test controls via env:
// FAKE_LOG (file to append one JSON record to), FAKE_LOGGED_IN=0, FAKE_MODE=normal|hang|stubborn|fail|maxturns|limit|toolerror.
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";

const argv = process.argv.slice(2);
const log = (rec) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(rec) + "\n");
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (argv[0] === "--version") {
  console.log("2.1.301 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = process.env.FAKE_LOGGED_IN !== "0";
  console.log(JSON.stringify(loggedIn ? { loggedIn: true, authMethod: "claude.ai", email: "ana@fernpoint.co" } : { loggedIn: false, authMethod: "none" }));
  process.exit(loggedIn ? 0 : 1);
}

const stdin = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (d) => (data += d));
  process.stdin.on("end", () => resolve(data));
});
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const mcpPath = flag("--mcp-config");
const mcpRaw = readFileSync(mcpPath, "utf8");
const server = JSON.parse(mcpRaw).mcpServers.slipstream;
const mode = process.env.FAKE_MODE ?? "normal";
const sessionId = flag("--resume") ?? "11111111-2222-4333-8444-555555555555";

log({
  bin: "claude",
  pid: process.pid,
  argv,
  stdin,
  cwd: process.cwd(),
  cwdEntries: readdirSync(process.cwd()),
  mcpConfig: JSON.parse(mcpRaw),
  mcpFileMode: statSync(mcpPath).mode & 0o777,
  cwdMode: statSync(process.cwd()).mode & 0o777,
  tokenInEnv: Boolean(process.env.SLIPSTREAM_TOKEN),
});

// Hooks in the person's settings emit events (with a session_id) before init.
out({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup", session_id: "hook-session-id" });
out({ type: "system", subtype: "init", session_id: sessionId, tools: [], mcp_servers: [{ name: "slipstream", status: "connected" }] });

if (mode === "fail") {
  process.stderr.write(`boom: ${server.headers.Authorization} while talking to the server\n`);
  process.exit(1);
}
if (mode === "hang" || mode === "stubborn") {
  if (mode === "stubborn") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: server.headers.Authorization },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mail_search", arguments: { query: "from:ana" } } }),
  });
  const rpc = await res.json();
  const text = rpc?.result?.content?.[0]?.text ?? `HTTP ${res.status}`;
  const isError = mode === "toolerror" || res.status !== 200;

  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "mcp__slipstream__mail_search", input: { query: "from:ana" } }] } });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text, is_error: isError }] } });
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Found: ${text}` }] } });
  const base = { type: "result", duration_ms: 10, num_turns: 2, session_id: sessionId, total_cost_usd: 0.42 };
  if (mode === "maxturns") out({ ...base, subtype: "error_max_turns", is_error: true });
  else if (mode === "limit") out({ ...base, subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm" });
  else out({ ...base, subtype: "success", is_error: false, result: `Found: ${text}` });
  process.exit(0);
}
