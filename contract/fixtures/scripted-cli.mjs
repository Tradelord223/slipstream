#!/usr/bin/env node
// A scripted stand-in for `claude` and `codex` that does a real task through Slipstream's /mcp with the
// run's token: search, draft a reply, ask to send. It prints each CLI's own stream format.
// scripted-claude.mjs / scripted-codex.mjs pick the flavour; TOKEN_LOG (optional) records the token it was given.
import { appendFileSync, readFileSync } from "node:fs";

const kind = process.env.CLI_KIND ?? "claude";
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv[0] === "--version") {
  console.log(kind === "claude" ? "2.1.301 (Claude Code)" : "codex-cli 0.159.0");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "ana@fernpoint.co" }));
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}

let url;
let token;
if (kind === "claude") {
  const server = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.slipstream;
  url = server.url;
  token = server.headers.Authorization.replace(/^Bearer /, "");
} else {
  const c = (key) => argv.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1).replace(/^"|"$/g, "");
  url = c("mcp_servers.slipstream.url");
  token = process.env[c("mcp_servers.slipstream.bearer_token_env_var")];
}
if (process.env.TOKEN_LOG) appendFileSync(process.env.TOKEN_LOG, token + "\n");

let n = 0;
async function call(name, args) {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? body);
  return { text, isError: Boolean(body.result?.isError || body.error) };
}

const tools = [];
async function tool(name, args) {
  const r = await call(name, args);
  tools.push({ name, ...r });
  if (kind === "claude") {
    const id = `toolu_${tools.length}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__slipstream__${name}`, input: args }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: r.isError, content: r.text }] } });
  } else {
    out({ type: "item.completed", item: { id: `item_${tools.length}`, type: "mcp_tool_call", server: "slipstream", tool: name, status: r.isError ? "failed" : "completed" } });
  }
  return r;
}

if (kind === "claude") out({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555" });
else out({ type: "thread.started", thread_id: "0199a000-0000-7000-8000-000000000001" });

const found = JSON.parse((await tool("mail_search", { query: "Dispatch", limit: 1 })).text);
const threadId = found.threads[0].id;
const draft = JSON.parse((await tool("drafts_create", { threadId, body: "Thanks, that works for us." })).text);
await tool("drafts_send", { draftId: draft.id });
const said = "Drafted a reply and asked you to approve sending it.";
if (kind === "claude") {
  out({ type: "assistant", message: { content: [{ type: "text", text: said }] } });
  out({ type: "result", subtype: "success", is_error: false, session_id: "11111111-2222-4333-8444-555555555555" });
} else {
  out({ type: "item.completed", item: { id: "item_msg", type: "agent_message", text: said } });
  out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
}
