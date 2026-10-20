import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeStdioArgs, claudeCodeStdioCommand, codexStdioArgs, codexStdioCommand, type Cli } from "../../web/src/lib/connect.ts";
import { Agents, type Scope } from "./agents/agents.ts";
import { findAssistantBinary } from "./agents/engines/cli.ts";
import { LOCAL_USER_ID, Users } from "./auth/users.ts";
import { loadConfig, readConfig } from "./config.ts";
import { Db } from "./db/index.ts";
import { formatReport, runDoctor } from "./doctor.ts";

/**
 * The command line and the stdio MCP bridge. Both talk to a running Slipstream over its agent API,
 * so every action is attributed, scoped, approvable and undoable like any other agent's.
 *
 *   slipstream mail.search --query "from:priya has:attachment"
 *   slipstream triage.done --threadIds '["thr_…"]'
 *   slipstream mcp            # stdio MCP for Claude Desktop/Code, Cursor, …
 *   slipstream connect claude # the command that adds Slipstream to Claude Code (or codex); --run does it
 *   slipstream doctor         # check this install (add --json for scripts and agents)
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
    throw new Error(`Can't reach Slipstream at ${baseUrl()}. Start it with \`slipstream\` (or \`npm start\` in the repo).`);
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

const ASSISTANTS = {
  claude: { name: "Claude Code", args: claudeCodeStdioArgs, command: claudeCodeStdioCommand },
  codex: { name: "Codex", args: codexStdioArgs, command: codexStdioCommand },
} as const;

/**
 * How an assistant starts the stdio bridge: this very program by absolute path, as Settings → Connect shows it,
 * since the assistant doesn't share your shell's PATH. Run through npx, that path is in a cache npm clears, so
 * the assistant gets npx itself, from next to this node.
 */
export function bridgeCli(entry: string, execPath: string, exists = existsSync): Cli {
  if (!entry.includes(`${sep}_npx${sep}`)) return { command: execPath, args: [entry] };
  const npx = join(dirname(execPath), "npx");
  return { command: exists(npx) ? npx : "npx", args: ["-y", "slipstream-mail"] };
}

/**
 * Connect Claude Code or Codex to this Slipstream over the stdio bridge, which keeps its own token, so
 * none is printed or lands in shell history. Prints the command; with `--run`, runs it.
 */
async function runConnect(args: string[]) {
  const target = args[0] === "claude" || args[0] === "codex" ? args[0] : null;
  const flags = args.slice(1);
  if (!target || flags.some((f) => f !== "--run")) throw new Error("Usage: slipstream connect <claude|codex> [--run]");
  const assistant = ASSISTANTS[target];
  const cli = bridgeCli(fileURLToPath(import.meta.url), process.execPath);
  const command = assistant.command(cli);
  if (!flags.includes("--run")) {
    console.log(command);
    console.error(`Run it to connect ${assistant.name}, or run \`slipstream connect ${target} --run\`. Slipstream has to be running when ${assistant.name} uses it.`);
    return;
  }
  const bin = findAssistantBinary(target);
  if (!bin) throw new Error(`${assistant.name} isn't installed (there is no \`${target}\` on your PATH). Install it, then run this again, or run this yourself:\n${command}`);
  console.log(command);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(bin, assistant.args(cli), { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
}

async function runCommand(argv: string[]) {
  const [name, ...rest] = argv;
  const token = localToken("cli");
  if (!name || name === "commands" || name === "help" || name === "--help") {
    const { json } = await call("/api/v1/commands", token);
    const list = (json as { commands: { name: string; title: string; scope: string }[] }).commands;
    console.log("Usage: slipstream <command> [--name value …]\n");
    for (const c of list) console.log(`  ${c.name.padEnd(24)} ${c.title}  (${c.scope})`);
    console.log("\n  slipstream mcp           Run as a stdio MCP server\n  slipstream connect <claude|codex> [--run]   Add Slipstream to Claude Code or Codex\n  slipstream doctor        Check this install (--json for scripts)\n  slipstream <command> --help   Show a command's inputs");
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

async function runDoctorCommand(args: string[]) {
  const report = await runDoctor(readConfig());
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report, Boolean(process.stdout.isTTY) && !process.env.NO_COLOR));
  if (report.summary.fail > 0) process.exitCode = 1;
}

export async function cli(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "mcp") await runMcpBridge();
    else if (argv[0] === "connect") await runConnect(argv.slice(1));
    else if (argv[0] === "doctor") await runDoctorCommand(argv.slice(1));
    else await runCommand(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void cli();
