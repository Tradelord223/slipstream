import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agents, type Scope } from "./agents/agents.ts";
import { LOCAL_USER_ID, Users } from "./auth/users.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db/index.ts";

/**
 * The command line and the stdio MCP bridge. Both talk to a running Slipstream over its agent API,
 * so every action is attributed, scoped, approvable and undoable like any other agent's.
 *
 *   slipstream mail.search --query "from:priya has:attachment"
 *   slipstream triage.done --threadIds '["thr_…"]'
 *   slipstream mcp            # stdio MCP for Claude Desktop/Code, Cursor, …
 *
 * Connection: SLIPSTREAM_URL (default http://127.0.0.1:4380) and SLIPSTREAM_TOKEN. In local mode
 * a token is created on first use and kept in the data directory.
 */

const DEFAULT_SCOPES: Scope[] = ["read", "triage", "draft", "send"];

function baseUrl(): string {
  const config = loadConfig();
  return (process.env.SLIPSTREAM_URL ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, "");
}

/** Find or create this tool's own agent token (local installs only). */
function localToken(kind: "cli" | "mcp"): string {
  if (process.env.SLIPSTREAM_TOKEN) return process.env.SLIPSTREAM_TOKEN;
  const config = loadConfig();
  const dir = join(config.dataDir, "agent-tokens");
  const file = join(dir, `${kind}.token`);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  if (config.mode !== "local") throw new Error("Set SLIPSTREAM_TOKEN to an agent token from Settings → Agents.");
  const db = new Db(config.dbPath);
  try {
    new Users(db).ensureLocalUser();
    const { token } = new Agents(db).create(LOCAL_USER_ID, kind === "mcp" ? "Local MCP" : "Command line", DEFAULT_SCOPES);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, token, { mode: 0o600 });
    return token;
  } finally {
    db.close();
  }
}

async function call(path: string, token: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Can't reach Slipstream at ${baseUrl()}. Start it with \`npx slipstream-mail\`.`);
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** `--key value` pairs (values parsed as JSON when they look like JSON), or one JSON object argument. */
export function parseArgs(args: string[]): Record<string, unknown> {
  if (args.length === 1 && args[0]!.trim().startsWith("{")) return JSON.parse(args[0]!) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) throw new Error(`Unexpected argument "${a}". Use --name value.`);
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const raw = inline ?? (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--") ? args[++i]! : "true");
    let value: unknown = raw;
    if (/^[[{"]|^(true|false|null|-?\d+(\.\d+)?)$/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    out[key] = value;
  }
  return out;
}

async function runMcpBridge() {
  const token = localToken("mcp");
  const upstream = new StreamableHTTPClientTransport(new URL(`${baseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const local = new StdioServerTransport();
  local.onmessage = (m) => void upstream.send(m).catch((err: Error) => console.error(`[slipstream mcp] ${err.message}`));
  upstream.onmessage = (m) => void local.send(m);
  upstream.onerror = (err) => console.error(`[slipstream mcp] ${err.message}`);
  local.onclose = () => void upstream.close();
  await upstream.start();
  await local.start();
}

async function runCommand(argv: string[]) {
  const [name, ...rest] = argv;
  const token = localToken("cli");
  if (!name || name === "commands" || name === "help" || name === "--help") {
    const { json } = await call("/api/v1/commands", token);
    const list = (json as { commands: { name: string; title: string; scope: string }[] }).commands;
    console.log("Usage: slipstream <command> [--name value …]\n");
    for (const c of list) console.log(`  ${c.name.padEnd(24)} ${c.title}  (${c.scope})`);
    console.log("\n  slipstream mcp           Run as a stdio MCP server\n  slipstream <command> --help   Show a command's inputs");
    return;
  }
  if (rest.includes("--help")) {
    const { json } = await call("/api/v1/commands", token);
    const c = (json as { commands: { name: string; description: string; input: unknown }[] }).commands.find((x) => x.name === name);
    if (!c) throw new Error(`Unknown command "${name}"`);
    console.log(`${c.name}\n\n${c.description}\n\nInput (JSON Schema):\n${JSON.stringify(c.input, null, 2)}`);
    return;
  }
  const { status, json } = await call(`/api/v1/${name}`, token, parseArgs(rest));
  console.log(JSON.stringify(json, null, 2));
  if (status >= 400) process.exitCode = 1;
}

export async function cli(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "mcp") await runMcpBridge();
    else await runCommand(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void cli();
