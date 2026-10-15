import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AppContext } from "../../context.ts";
import { MAX_TOOL_CALLS_PER_TURN, type Engine, type EngineId, type EngineStatus, type RunIO, type TurnOutcome } from "./types.ts";

/**
 * CLI engines: the person's own Claude Code or Codex, signed in with their own account, driven as an
 * unmodified child process. Slipstream gives the child its MCP server (a run-scoped bearer token) as the
 * only tools it may use, so scopes, approvals, attribution and undo stay the same as for every engine.
 * Slipstream never reads either CLI's credentials or config; the CLI finds its own login.
 */

const PROBE_TIMEOUT_MS = 5_000;
const STATUS_TTL_MS = 60_000;
const TURN_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 3_000;
const MCP_PREFIX = "mcp__slipstream__";
const LIMIT_RE = /usage.?limit|hit your limit|limit reached|rate.?limit/i;

interface CliSpec {
  id: EngineId;
  label: string;
  binName: string;
  envVar: string;
  note: string;
  installHint: string;
  loginHint: string;
}

const CLAUDE: CliSpec = {
  id: "cli:claude-code",
  label: "Claude Code",
  binName: "claude",
  envVar: "SLIPSTREAM_CLAUDE_BIN",
  note: "Runs your own Claude Code with your own sign-in; usage counts against your Claude plan. Anthropic's terms: https://code.claude.com/docs/en/legal-and-compliance",
  installHint: "Claude Code isn't installed. Install it with: curl -fsSL https://claude.ai/install.sh | bash (or brew install --cask claude-code).",
  loginHint: "Claude Code isn't signed in. Run claude in a terminal (or claude auth login) and sign in.",
};

const CODEX: CliSpec = {
  id: "cli:codex",
  label: "Codex",
  binName: "codex",
  envVar: "SLIPSTREAM_CODEX_BIN",
  note: "Runs your own Codex with your ChatGPT sign-in. Codex keeps its own shell tool even in read-only mode; Slipstream runs it in an empty folder with a read-only sandbox.",
  installHint: "Codex isn't installed. Install it with: npm install -g @openai/codex (or brew install --cask codex).",
  loginHint: "Codex isn't signed in. Run codex login in a terminal and sign in with ChatGPT.",
};

/** The common install dirs, searched after PATH because a server started outside a login shell may have a thin PATH. */
function searchDirs(): string[] {
  const home = homedir();
  const extra = [join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin")];
  return [...new Set([...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...extra])];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(spec: CliSpec): string | null {
  const override = process.env[spec.envVar];
  if (override) return isExecutable(override) ? override : null;
  for (const dir of searchDirs()) {
    const candidate = join(dir, spec.binName);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** API keys the CLIs would prefer over the person's sign-in, which would bill an API account instead of their plan. */
const BILLING_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"];

/** The child's environment: ours minus API keys, plus the binary's own folder on PATH (npm shims need `node` beside them). */
function childEnv(bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const path = [dirname(bin), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)].join(delimiter);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, ...extra };
  for (const k of BILLING_KEYS) delete env[k];
  return env;
}

/** Hides the run's token, and anything shaped like a credential, before text is shown to a person. */
function redact(text: string, token: string): string {
  let out = token ? text.split(token).join("[redacted]") : text;
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/\b(?:sk|ss|gh[pousr])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]");
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
  return out;
}

interface Probe {
  code: number | null;
  out: string;
  timedOut: boolean;
}

/** A short read-only command (`--version`, `login status`); never carries a prompt. */
function probe(bin: string, args: string[]): Promise<Probe> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const child = spawn(bin, args, { env: childEnv(bin), stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => void (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => void (out += d.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

interface Ran {
  code: number | null;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Runs the CLI for one turn: prompt on stdin, stdout handed over line by line. Abort and the turn
 * timeout stop the child's whole process group (SIGTERM, then SIGKILL after a grace period).
 */
function runCli(io: RunIO, bin: string, args: string[], opts: { cwd: string; stdin: string; env: NodeJS.ProcessEnv; onLine(line: string): void }): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stderr = "";
    let buffer = "";
    let aborted = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const stop = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const turnTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, TURN_TIMEOUT_MS);
    if (io.signal.aborted) onAbort();
    else io.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (r: Omit<Ran, "stderr" | "aborted" | "timedOut">) => {
      clearTimeout(turnTimer);
      if (killTimer) clearTimeout(killTimer);
      io.signal.removeEventListener("abort", onAbort);
      if (buffer.trim()) opts.onLine(buffer);
      resolve({ ...r, stderr: stderr.slice(-500), aborted, timedOut });
    };

    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) opts.onLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => void (stderr = (stderr + d.toString("utf8")).slice(-2000)));
    child.stdin.on("error", () => {});
    child.on("error", (err) => finish({ code: null, spawnError: err.message }));
    child.on("close", (code) => finish({ code }));
    child.stdin.end(opts.stdin);
  });
}

function endedEarly(spec: CliSpec, ran: Ran, token: string): TurnOutcome {
  if (ran.aborted) return { outcome: "failed", error: "Stopped before it finished." };
  if (ran.timedOut) return { outcome: "failed", error: `${spec.label} took longer than 10 minutes and was stopped.` };
  if (ran.spawnError) return { outcome: "failed", error: `Couldn't start ${spec.label}: ${redact(ran.spawnError, token)}` };
  const tail = redact(ran.stderr.trim(), token);
  return { outcome: "failed", error: `${spec.label} stopped without an answer (exit ${ran.code ?? "unknown"})${tail ? `: ${tail}` : "."}` };
}

function failure(message: string, token: string): TurnOutcome {
  const text = redact(message, token);
  return LIMIT_RE.test(text) ? { outcome: "limit", error: text } : { outcome: "failed", error: text };
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

async function withTurnDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  // mkdtemp makes the folder owner-only (0700); the CLI works in it and nothing outlives the turn.
  const dir = mkdtempSync(join(tmpdir(), "slipstream-cli-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function claudeTurn(io: RunIO, message: string, bin: string): Promise<TurnOutcome> {
  const { url, token } = io.mcpAccess();
  const resume = io.loadState<{ sessionId?: string }>()?.sessionId;
  return withTurnDir(async (dir) => {
    const mcpConfig = join(dir, "mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { slipstream: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
    // --tools "" removes every built-in tool; dontAsk denies anything not in --allowedTools; --strict-mcp-config
    // keeps the person's own MCP servers out; "project,local" skips their user settings (hooks, env) and, in this
    // empty folder, loads nothing. Each variadic flag is followed by another flag, and the prompt is on stdin.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      `${MCP_PREFIX}*`,
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "project,local",
      "--max-turns",
      String(MAX_TOOL_CALLS_PER_TURN),
      "--append-system-prompt",
      io.systemPrompt,
    ];
    if (io.model) args.push("--model", io.model);
    if (resume) args.push("--resume", resume);

    const calls = new Map<string, string>();
    let result: Record<string, unknown> | null = null;
    const onLine = (line: string) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (ev.type === "system") {
        // Hook events carry a session_id too; only init names the session to resume.
        const id = str(ev.session_id);
        if (ev.subtype === "init" && id) io.saveState({ sessionId: id });
      } else if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "text" && str(block.text)?.trim()) io.say(str(block.text)!.trim());
          else if (block.type === "tool_use" && str(block.id) && str(block.name)) calls.set(str(block.id)!, str(block.name)!);
        }
      } else if (ev.type === "user") {
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) return;
        for (const block of content as Record<string, unknown>[]) {
          const name = block.type === "tool_result" ? calls.get(str(block.tool_use_id) ?? "") : undefined;
          if (name) io.toolLine(name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name, block.is_error === true);
        }
      } else if (ev.type === "result") {
        result = ev;
      }
    };

    const ran = await runCli(io, bin, args, { cwd: dir, stdin: message, env: childEnv(bin, { SLIPSTREAM_TOKEN: token }), onLine });
    const res = result as Record<string, unknown> | null;
    if (ran.aborted || ran.timedOut || !res) return endedEarly(CLAUDE, ran, token);
    // No cost is added: this is the person's plan, not an API key.
    if (res.subtype === "success" && res.is_error !== true) return { outcome: "done" };
    if (res.subtype === "error_max_turns") return { outcome: "limit", error: `Claude Code stopped after ${MAX_TOOL_CALLS_PER_TURN} turns.` };
    const errors = Array.isArray(res.errors) ? (res.errors as unknown[]).filter((e) => typeof e === "string").join("; ") : "";
    return failure(str(res.result) || errors || `Claude Code failed (${str(res.subtype) ?? "error"}).`, token);
  });
}

async function codexTurn(io: RunIO, message: string, bin: string): Promise<TurnOutcome> {
  const { url, token } = io.mcpAccess();
  const resume = io.loadState<{ threadId?: string }>()?.threadId;
  return withTurnDir(async (dir) => {
    // Every -c value is a TOML string; a JSON string literal is a valid one.
    const q = JSON.stringify;
    // codex merges -c into the person's config rather than replacing mcp_servers, so --ignore-user-config
    // keeps their other MCP servers (and instructions) out; auth still comes from their own login.
    const common = [
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-c",
      `sandbox_mode=${q("read-only")}`,
      "-c",
      `approval_policy=${q("never")}`,
      "-c",
      `web_search=${q("disabled")}`,
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      `developer_instructions=${q(io.systemPrompt)}`,
      "-c",
      `mcp_servers.slipstream.url=${q(url)}`,
      "-c",
      `mcp_servers.slipstream.bearer_token_env_var=${q("SLIPSTREAM_TOKEN")}`,
      "-c",
      `mcp_servers.slipstream.default_tools_approval_mode=${q("approve")}`,
      "-c",
      "mcp_servers.slipstream.required=true",
    ];
    if (io.model) common.push("-m", io.model);
    const args = resume
      ? ["exec", "-s", "read-only", "-C", dir, "resume", ...common, resume, "-"]
      : ["exec", "-s", "read-only", "-C", dir, ...common, "-"];

    let completed = false;
    let failed: string | null = null;
    let lastError: string | null = null;
    const onLine = (line: string) => {
      const ev = parseJson(line);
      if (!ev) return;
      const errorText = (v: unknown) => str((v as { message?: unknown } | undefined)?.message) ?? str(v);
      if (ev.type === "thread.started" && str(ev.thread_id)) io.saveState({ threadId: str(ev.thread_id) });
      else if (ev.type === "item.completed") {
        const item = ev.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && str(item.text)?.trim()) io.say(str(item.text)!.trim());
        else if (item?.type === "mcp_tool_call" && str(item.tool)) io.toolLine(str(item.tool)!, item.status === "failed" || Boolean(item.error));
      } else if (ev.type === "turn.completed") completed = true;
      else if (ev.type === "turn.failed") failed = errorText(ev.error) ?? "Codex couldn't finish the turn.";
      // A bare error can be a transient reconnect notice; only the end of the turn decides.
      else if (ev.type === "error") lastError = errorText(ev.message) ?? lastError;
    };

    const ran = await runCli(io, bin, args, { cwd: dir, stdin: message, env: childEnv(bin, { SLIPSTREAM_TOKEN: token }), onLine });
    if (ran.aborted || ran.timedOut) return endedEarly(CODEX, ran, token);
    if (completed) return { outcome: "done" };
    const reason = failed ?? lastError;
    return reason ? failure(reason, token) : endedEarly(CODEX, ran, token);
  });
}

async function claudeStatus(bin: string): Promise<Pick<EngineStatus, "ready" | "detail" | "needs">> {
  const p = await probe(bin, ["auth", "status", "--json"]);
  const info = parseJson(p.out.slice(Math.max(p.out.indexOf("{"), 0)));
  if (info && (info.loggedIn === false || info.authMethod === "none")) return { ready: false, needs: "login", detail: CLAUDE.loginHint };
  if (info?.loggedIn === true) return { ready: true, detail: str(info.email) ? `Signed in to Claude Code as ${str(info.email)}` : "Uses your Claude Code sign-in" };
  // An older Claude Code without `auth status`, or a probe that timed out: runs will say if it isn't signed in.
  return { ready: true, detail: "Uses your Claude Code sign-in" };
}

async function codexStatus(bin: string): Promise<Pick<EngineStatus, "ready" | "detail" | "needs">> {
  const p = await probe(bin, ["login", "status"]);
  const text = p.out.trim();
  if (p.timedOut) return { ready: true, detail: "Uses your Codex sign-in" };
  if (p.code !== 0 || /not logged in/i.test(text)) return { ready: false, needs: "login", detail: CODEX.loginHint };
  if (/api key/i.test(text)) return { ready: true, detail: "Codex is signed in with an API key, so usage is billed to that key rather than your ChatGPT plan." };
  return { ready: true, detail: text.split("\n")[0] || "Uses your Codex sign-in" };
}

function makeEngine(ctx: AppContext, spec: CliSpec, checkLogin: (bin: string) => Promise<Pick<EngineStatus, "ready" | "detail" | "needs">>, run: (io: RunIO, message: string, bin: string) => Promise<TurnOutcome>): Engine {
  let cached: { at: number; status: EngineStatus } | null = null;
  const base = { id: spec.id, label: spec.label, kind: "cli" as const, billing: "plan" as const, note: spec.note, model: null };
  return {
    id: spec.id,
    label: spec.label,
    kind: "cli",
    async status() {
      if (ctx.config.mode === "team") return { ...base, ready: false, detail: "Available when Slipstream runs on your own computer." };
      if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
      const bin = findBinary(spec);
      const status: EngineStatus = bin ? { ...base, ...(await checkLogin(bin)) } : { ...base, ready: false, needs: "install", detail: spec.installHint };
      cached = { at: Date.now(), status };
      return status;
    },
    async turn(io, message) {
      if (ctx.config.mode === "team") return { outcome: "failed", error: "Available when Slipstream runs on your own computer." };
      const bin = findBinary(spec);
      if (!bin) return { outcome: "failed", error: spec.installHint };
      return run(io, message, bin);
    },
  };
}

/** Claude Code and Codex, run from the person's own installs. Local mode only: they sign in as the person at the computer. */
export function cliEngines(ctx: AppContext): Engine[] {
  return [makeEngine(ctx, CLAUDE, claudeStatus, claudeTurn), makeEngine(ctx, CODEX, codexStatus, codexTurn)];
}
