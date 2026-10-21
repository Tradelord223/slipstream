import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { stableNode } from "./bridge.ts";
import { packageVersion } from "./version.ts";

/**
 * `slipstream service`: start Slipstream when you log in and bring it back if it stops, with a macOS launch agent or
 * a Linux systemd user unit. The builders at the top are pure so they can be tested without touching a machine;
 * the install, uninstall and status actions below them do the work, with the machine's pieces passed in.
 */

export type Health = "slipstream" | "other" | "none";

const DEFAULT_PORT = 4380;

/** The launch agent's label, and so its file name, per port, so two installs on different ports don't replace each other. */
export const serviceLabel = (port: number) => (port === DEFAULT_PORT ? "com.slipstream-mail" : `com.slipstream-mail.${port}`);
export const unitName = (port: number) => (port === DEFAULT_PORT ? "slipstream.service" : `slipstream-${port}.service`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const unxml = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** A control character would end a line in a unit or break the plist's XML, so it never gets into either. */
function clean(what: string, value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${what} has a control character in it, which a service file can't hold.`);
  return value;
}

export interface LaunchAgent {
  label: string;
  program: string[];
  env: Record<string, string>;
  logPath: string;
  workingDir: string;
}

/**
 * KeepAlive with SuccessfulExit false restarts it after a crash but not after a clean quit; ThrottleInterval keeps a
 * broken install from restarting in a tight loop. Umask 63 is 077, so the log and anything else it creates is owner-only.
 */
export function launchAgentPlist(a: LaunchAgent): string {
  const strings = (items: string[]) => items.map((s) => `    <string>${xml(clean("A program argument", s))}</string>`).join("\n");
  const env = Object.entries(a.env).map(([k, v]) => `    <key>${xml(clean("A variable name", k))}</key>\n    <string>${xml(clean(`${k}`, v))}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(clean("The label", a.label))}</string>
  <key>ProgramArguments</key>
  <array>
${strings(a.program)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(clean("The log path", a.logPath))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(a.logPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xml(clean("The working folder", a.workingDir))}</string>
</dict>
</plist>
`;
}

/** A systemd word: in double quotes, with backslash and quote escaped and `%` doubled (`$` too, which ExecStart would expand). */
const systemdQuote = (s: string, expandsVariables = false) => {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${expandsVariables ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
};

export interface SystemdUnit {
  description: string;
  program: string[];
  env: Record<string, string>;
  logPath: string;
}

export function systemdUnit(u: SystemdUnit): string {
  const env = Object.entries(u.env).map(([k, v]) => `Environment=${systemdQuote(`${clean("A variable name", k)}=${clean(k, v)}`)}`);
  const log = `append:${clean("The log path", u.logPath).replace(/%/g, "%%")}`;
  return [
    "[Unit]",
    `Description=${clean("The description", u.description)}`,
    "",
    "[Service]",
    `ExecStart=${u.program.map((a) => systemdQuote(clean("A program argument", a), true)).join(" ")}`,
    ...env,
    "Restart=on-failure",
    "RestartSec=30",
    "UMask=0077",
    `StandardOutput=${log}`,
    `StandardError=${log}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * PATH for the service: absolute entries only (a relative one would mean something else from the service's folder),
 * without the entries npx adds for its own run, which are gone once npx is. Order kept, repeats dropped.
 */
export function servicePath(path: string | undefined): string {
  const kept = (path ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .map((p) => p.replace(/\/+$/, "") || "/")
    .filter((p) => !p.includes("/_npx/") && !p.endsWith("node_modules/.bin"));
  return [...new Set(kept)].join(delimiter);
}

/** What the service is started with besides PATH and the data folder, and why each is carried. A service doesn't see the shell it was installed from. */
export const SERVICE_ENV: { names: string[]; why: string }[] = [
  { names: ["SLIPSTREAM_*"], why: "Slipstream's own settings, such as the port, the host and where the data lives." },
  { names: ["PORT"], why: "The port the service answers on." },
  { names: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], why: "Refreshing Gmail sign-ins." },
  { names: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT"], why: "Refreshing Outlook sign-ins." },
  { names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"], why: "The assistants Slipstream runs for you." },
  { names: ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL", "OPENROUTER_BASE_URL"], why: "Assistants reached through a gateway or a local endpoint." },
  { names: ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"], why: "Reaching mail servers and assistants from behind a proxy." },
  { names: ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"], why: "Trusting a company or proxy certificate." },
  { names: ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"], why: "Where Claude Code and Codex keep their sign-ins, so Autopilot finds them." },
  { names: ["(named in SLIPSTREAM_CLI_ENV)"], why: "Extra variables you pass to Claude Code and Codex." },
];

/** SLIPSTREAM_* settings the service leaves out, and why. */
export const SERVICE_ENV_LEFT_OUT: { name: string; why: string }[] = [
  { name: "SLIPSTREAM_SECRET", why: "Refused: the service can't use it yet, and without it the saved sign-ins couldn't be opened." },
  { name: "SLIPSTREAM_TOKEN", why: "A command-line client setting, not the server's." },
  { name: "SLIPSTREAM_URL", why: "A command-line client setting, not the server's." },
  { name: "SLIPSTREAM_MODE", why: "The service is always the local mode." },
];

const carriedNames = new Set(SERVICE_ENV.flatMap((e) => e.names).filter((n) => /^[A-Za-z_]+$/.test(n)));
const leftOut = new Set(SERVICE_ENV_LEFT_OUT.map((e) => e.name));
/** Variables whose value is a secret, so the file holding them is private and the install says it keeps them. */
const isSecretName = (name: string) => /_SECRET$|_API_KEY$/.test(name);

/** What the service is started with: the variables listed in SERVICE_ENV that are set, the data folder as an absolute path, and a PATH so it can find the assistants it runs. */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.SLIPSTREAM_SECRET) {
    throw new Error("The start-at-login service can't use SLIPSTREAM_SECRET yet, and without it Slipstream couldn't open your saved sign-ins. Keep running Slipstream from a terminal for now.");
  }
  const out: Record<string, string> = {};
  const cliExtra = new Set((env.SLIPSTREAM_CLI_ENV ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (!value || leftOut.has(name)) continue;
    if (carriedNames.has(name) || cliExtra.has(name) || name.startsWith("SLIPSTREAM_")) out[name] = value;
  }
  if (out.SLIPSTREAM_DATA_DIR) out.SLIPSTREAM_DATA_DIR = resolve(out.SLIPSTREAM_DATA_DIR);
  const path = servicePath(env.PATH);
  if (path) out.PATH = path;
  return out;
}

/** The directory holding the slipstream-mail package.json that `entry` (cli.js in a build, cli.ts in a checkout) sits under. */
function packageRoot(entry: string): string {
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    try {
      if ((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name === "slipstream-mail") return dir;
    } catch {
      // no package.json here
    }
    if (dirname(dir) === dir) throw new Error(`Couldn't find the slipstream-mail package that ${entry} belongs to.`);
  }
}

const MARKER = ".slipstream-service.json";

interface Marker {
  version: string;
  label: string;
  copiedAt: string;
}

/** The app copy for one service: its own folder per label, so a service on another port keeps its copy. */
export const serviceCopyDir = (dataDir: string, label: string) => join(dataDir, "service", label);

function readMarker(dir: string): Marker | null {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as Marker;
  } catch {
    return null;
  }
}

/** A folder is only ours to delete when it carries the marker this service wrote into it. */
const isOurCopy = (dir: string, label: string) => readMarker(dir)?.label === label;

export interface ProgramPlan {
  program: string[];
  /** Set when the package sits in npx's cache: what to copy (the node_modules folder npx made), and where the copy ends up. */
  copy: { from: string; dir: string; version: string } | null;
}

/**
 * The command the service runs: node, this program's bin script, and `serve`. Run through npx, the package sits in
 * a cache npm clears, so everything npx installed is copied under the data folder and run from there (no network, no
 * npm). Each install replaces the copy, which is how an upgrade lands. This only plans; stageCopy and swapCopy do it.
 */
export function resolveProgram(entry: string, execPath: string, dataDir: string, label: string, where: { path?: string; realpath?: (p: string) => string } = {}): ProgramPlan {
  const root = packageRoot(entry);
  const node = stableNode(execPath, where.path ?? servicePath(process.env.PATH), where.realpath ?? realpathSync);
  if (!root.includes(`${sep}_npx${sep}`)) {
    const bin = join(root, "bin", "slipstream.js");
    if (!existsSync(bin)) throw new Error(`Couldn't find ${bin} to start.`);
    return { program: [node, bin, "serve"], copy: null };
  }
  const dir = serviceCopyDir(dataDir, label);
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  const bin = join(dir, "node_modules", basename(root), "bin", "slipstream.js");
  return { program: [node, bin, "serve"], copy: { from: dirname(root), dir, version } };
}

export type Copy = (from: string, to: string) => void;
const copyTree: Copy = (from, to) => cpSync(from, to, { recursive: true, verbatimSymlinks: true });

/**
 * Copies into `<dir>.next` and checks the script is there, without touching the running copy. The marker goes in
 * first, so a half-made folder is still recognisably ours.
 */
function stageCopy(plan: ProgramPlan, label: string, copy: Copy): void {
  const c = plan.copy!;
  const next = `${c.dir}.next`;
  for (const dir of [c.dir, next, `${c.dir}.old`]) {
    if (existsSync(dir) && !isOurCopy(dir, label)) throw new Error(`${dir} is in the way and isn't a Slipstream service copy, so it was left alone. Move it aside and run this again.`);
  }
  rmSync(next, { recursive: true, force: true });
  rmSync(`${c.dir}.old`, { recursive: true, force: true });
  try {
    mkdirSync(next, { recursive: true, mode: 0o700 });
    const marker: Marker = { version: c.version, label, copiedAt: new Date().toISOString() };
    writeFileSync(join(next, MARKER), JSON.stringify(marker, null, 2));
    copy(c.from, join(next, "node_modules"));
    const bin = plan.program[1]!.replace(c.dir, () => next);
    if (!existsSync(bin)) throw new Error(`The copy of Slipstream is missing ${bin}.`);
  } catch (err) {
    rmSync(next, { recursive: true, force: true });
    throw err;
  }
}

/** Puts the staged copy in place, keeping the old one beside it until `finish`, or putting it back with `undo`. */
function swapCopy(dir: string): { undo: () => void; finish: () => void } {
  const next = `${dir}.next`;
  const old = `${dir}.old`;
  const had = existsSync(dir);
  if (had) renameSync(dir, old);
  try {
    renameSync(next, dir);
  } catch (err) {
    if (had) renameSync(old, dir);
    throw err;
  }
  return {
    undo: () => {
      rmSync(dir, { recursive: true, force: true });
      if (had) renameSync(old, dir);
    },
    finish: () => {
      try {
        rmSync(old, { recursive: true, force: true });
      } catch {
        // a leftover .old is cleared by the next install
      }
    },
  };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export type Run = (cmd: string, args: string[]) => RunResult;

/** Looks the command up on PATH when it runs, so a launcher can be swapped by changing PATH. */
const spawnRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

/** The machine and the program an action works on. Every piece can be replaced in tests. */
export interface ServiceOptions {
  /** What to type to run Slipstream, for the messages. */
  self: string;
  port: number;
  dataDir: string;
  /** Is something answering Slipstream's health check at this URL? */
  probe: (url: string) => Promise<Health>;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  run?: Run;
  /** The version of the Slipstream being run, which status compares the service's with. */
  version?: string;
}

export interface InstallOptions extends ServiceOptions {
  /** cli.ts's own file, which says which package and which install this is. */
  entry: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for it to answer after starting. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Copies npx's node_modules into the app copy. */
  copy?: Copy;
}

/** Where the launch agent or systemd unit lives, or null where Slipstream can't set one up. */
export function serviceFile(port: number, platform: NodeJS.Platform = process.platform, home = homedir()): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${serviceLabel(port)}.plist`);
  if (platform === "linux") return join(home, ".config", "systemd", "user", unitName(port));
  return null;
}

interface Target {
  kind: "launchd" | "systemd";
  file: string;
  /** launchd's `gui/<uid>/<label>`, or the unit's name. */
  id: string;
  label: string;
  domain: string;
  logPath: string;
  run: Run;
  log: (line: string) => void;
}

function target(o: ServiceOptions): Target {
  // The port goes into the label and file names, so it has to be a real one.
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error(`${o.port} isn't a port number (1 to 65535).`);
  const platform = o.platform ?? process.platform;
  const file = serviceFile(o.port, platform, o.home);
  if (!file) throw new Error(`Starting at login isn't supported on ${platform} yet. Run \`${o.self}\` in a terminal instead.`);
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  return {
    kind: platform === "darwin" ? "launchd" : "systemd",
    file,
    id: platform === "darwin" ? `${domain}/${serviceLabel(o.port)}` : unitName(o.port),
    label: serviceLabel(o.port),
    domain,
    logPath: join(o.dataDir, "logs", "server.log"),
    run: o.run ?? spawnRun,
    log: o.log ?? ((line) => console.log(line)),
  };
}

const systemctl = ["--user"]; // the user's own units, so no root

/** Is the service loaded in launchd, or running in systemd? */
function isLoaded(t: Target): boolean {
  const r = t.kind === "launchd" ? t.run("launchctl", ["print", t.id]) : t.run("systemctl", [...systemctl, "is-active", "--quiet", t.id]);
  return r.status === 0;
}

/** The error for a command that had to work and didn't: which command, and why. */
function failed(cmd: string, args: string[], r: RunResult): Error {
  const why = r.error?.message ?? (r.stderr.trim() || r.stdout.trim() || `exit code ${r.status}`);
  return new Error(`\`${cmd} ${args.join(" ")}\` failed: ${why}`);
}

/** Runs a command that has to work. */
function must(t: Target, cmd: string, args: string[]): void {
  const r = t.run(cmd, args);
  if (r.status !== 0) throw failed(cmd, args, r);
}

/** Stops it and takes it out of launchd, or stops the unit. Not being loaded isn't an error. */
function stop(t: Target): void {
  if (t.kind === "launchd") t.run("launchctl", ["bootout", t.id]);
  else t.run("systemctl", [...systemctl, "stop", t.id]);
}

/** Writes a file only its owner can read, since it can hold keys. The mode is set again because an existing file keeps its own. */
function writePrivate(file: string, text: string | Uint8Array): void {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const LOG_LIMIT = 5 * 1024 * 1024;
const LOG_KEEP = 1024 * 1024;

/**
 * The log is made here, private, because launchd creates a missing one before it applies the service's Umask. An existing
 * one may have looser permissions, and a service that restarts for months grows it, so keep it private and bounded.
 */
function tidyLog(logPath: string): void {
  if (!existsSync(logPath)) return writePrivate(logPath, "");
  chmodSync(logPath, 0o600);
  const size = statSync(logPath).size;
  if (size <= LOG_LIMIT) return;
  const buf = Buffer.alloc(LOG_KEEP);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buf, 0, LOG_KEEP, size - LOG_KEEP);
  } finally {
    closeSync(fd);
  }
  writePrivate(logPath, buf);
}

/** What the service file says it runs and with which settings, read back from our own plist or unit. */
function readServiceFile(kind: Target["kind"], text: string): { program: string[]; env: Record<string, string> } {
  if (kind === "launchd") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
    return {
      program: [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]!)),
      env: Object.fromEntries([...dict.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map((m) => [unxml(m[1]!), unxml(m[2]!)])),
    };
  }
  const unquote = (s: string) => s.replace(/\\(.)|%%|\$\$/g, (m, c?: string) => c ?? m[0]!);
  const words = (line: string) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]!));
  const lines = text.split("\n");
  const exec = lines.find((l) => l.startsWith("ExecStart="));
  const env = lines.filter((l) => l.startsWith("Environment=")).map((l) => words(l)[0] ?? "");
  return {
    program: exec ? words(exec) : [],
    env: Object.fromEntries(env.filter((e) => e.includes("=")).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)])),
  };
}

const sameDir = (a: string, b: string) => {
  const canon = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return canon(a) === canon(b);
};

/** Another label's service on this data folder, which would fight this one over the same database. */
function otherServiceUsing(o: ServiceOptions, t: Target): { label: string; port: number } | null {
  const home = o.home ?? homedir();
  const dir = dirname(t.file);
  const name = t.kind === "launchd" ? /^(com\.slipstream-mail(?:\.(\d+))?)\.plist$/ : /^(slipstream(?:-(\d+))?)\.service$/;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of names.sort()) {
    const m = name.exec(file);
    if (!m || join(dir, file) === t.file) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const theirs = readServiceFile(t.kind, text).env.SLIPSTREAM_DATA_DIR ?? join(home, ".slipstream");
    if (sameDir(theirs, o.dataDir)) return { label: m[1]!, port: m[2] ? Number(m[2]) : DEFAULT_PORT };
  }
  return null;
}

/** The data folder an installed service records in its file, so uninstall and status act on that one and not on this shell's. */
function installedDataDir(t: Target): string | null {
  try {
    return readServiceFile(t.kind, readFileSync(t.file, "utf8")).env.SLIPSTREAM_DATA_DIR ?? null;
  } catch {
    return null;
  }
}

/** Starts the service from its file. Right after a bootout, launchd can still be tearing the old job down, so bootstrap gets a few tries. */
async function startService(t: Target, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (t.kind === "systemd") {
    must(t, "systemctl", [...systemctl, "daemon-reload"]);
    must(t, "systemctl", [...systemctl, "enable", t.id]);
    must(t, "systemctl", [...systemctl, "restart", t.id]);
    return;
  }
  const args = ["bootstrap", t.domain, t.file];
  for (let attempt = 1; ; attempt++) {
    const r = t.run("launchctl", args);
    if (r.status === 0) return;
    if (attempt === 3) throw failed("launchctl", args, r);
    await sleep(1_000);
  }
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function installService(o: InstallOptions): Promise<void> {
  const t = target(o);
  // Refuses SLIPSTREAM_SECRET before anything changes. The data folder is always written down, so uninstall and status find it.
  const env = { ...serviceEnv(o.env), SLIPSTREAM_DATA_DIR: resolve(o.dataDir) };
  const clash = otherServiceUsing(o, t);
  if (clash) throw new Error(`Another Slipstream service (${clash.label}) already uses ${o.dataDir}. Run \`${o.self} service uninstall\` with PORT=${clash.port} first.`);
  const theirs = installedDataDir(t);
  if (theirs && !sameDir(theirs, o.dataDir)) throw new Error(`This service uses the data folder ${theirs}. Run this again with SLIPSTREAM_DATA_DIR=${theirs}, or run \`${o.self} service uninstall\` first.`);
  const url = `http://127.0.0.1:${o.port}`;
  const loaded = isLoaded(t);
  if (!loaded) {
    // A copy started by hand would hold the port, so the service could never come up.
    const health = await o.probe(`${url}/api/health`);
    if (health === "slipstream") throw new Error(`Slipstream is already running at ${url}, but not as a service. Stop it (Ctrl-C in its terminal), then run this again.`);
    if (health === "other") throw new Error(`Another program is using port ${o.port}. Quit it, or use another port: PORT=4381 ${o.self} service install`);
  }

  const sleep = o.sleep ?? pause;
  const plan = resolveProgram(o.entry, o.execPath ?? process.execPath, o.dataDir, t.label);
  // Built now so a value the file can't hold is refused before anything changes.
  const text =
    t.kind === "launchd"
      ? launchAgentPlist({ label: t.label, program: plan.program, env, logPath: t.logPath, workingDir: o.dataDir })
      : systemdUnit({ description: "Slipstream mail", program: plan.program, env, logPath: t.logPath });
  // The new copy is made while the old service still runs, so a copy that fails costs nothing.
  if (plan.copy) stageCopy(plan, t.label, o.copy ?? copyTree);
  mkdirSync(dirname(t.logPath), { recursive: true, mode: 0o700 });
  tidyLog(t.logPath);
  mkdirSync(dirname(t.file), { recursive: true, ...(t.kind === "systemd" ? { mode: 0o700 } : {}) });

  const previous = existsSync(t.file) ? readFileSync(t.file, "utf8") : null;
  // Stopped before the app copy is replaced, and so a new file is read fresh.
  if (loaded || previous !== null) stop(t);
  let swap: ReturnType<typeof swapCopy> | null = null;
  try {
    if (plan.copy) swap = swapCopy(plan.copy.dir);
    writePrivate(t.file, text); // launchd refuses a plist that others can write to; 0600 is fine for it
    await startService(t, sleep);
  } catch (err) {
    throw new Error(`${(err as Error).message}${await rollback(t, swap, previous, loaded, sleep)}`);
  }

  // The old copy is kept until the new one answers, so an upgrade that doesn't come up can go back to it.
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  while ((await o.probe(`${url}/api/health`)) !== "slipstream") {
    if (Date.now() >= deadline) {
      const why = `Slipstream was set up to start at login, but it hasn't answered at ${url}. Its log is at ${t.logPath}`;
      throw new Error(previous === null ? why : `${why}${await rollback(t, swap, previous, loaded, sleep)}`);
    }
    await sleep(500);
  }
  swap?.finish();
  t.log(`Slipstream will now start when you log in and restart if it stops.\n  → ${url}\n  logs: ${t.logPath}`);
  const secrets = Object.keys(env).filter(isSecretName);
  if (secrets.length) t.log(`The service file keeps ${secrets.join(", ")} for it; only you can read that file.`);
  t.log("To give it its own window and Dock icon, open that address in Chrome and choose Install, or in Safari choose File → Add to Dock.");
}

/**
 * A failed install puts back what it replaced: the old app copy, the old file, and the old service if it was running.
 * Returns a sentence for the error, or nothing when there was no earlier install to go back to.
 */
async function rollback(t: Target, swap: ReturnType<typeof swapCopy> | null, previous: string | null, wasLoaded: boolean, sleep: (ms: number) => Promise<void>): Promise<string> {
  try {
    // The new job comes down first, so it isn't running from a folder that is about to change.
    stop(t);
    if (previous === null && t.kind === "systemd") t.run("systemctl", [...systemctl, "disable", t.id]);
    swap?.undo();
    if (previous === null) {
      rmSync(t.file, { force: true });
      if (t.kind === "systemd") t.run("systemctl", [...systemctl, "daemon-reload"]);
      return "";
    }
    writePrivate(t.file, previous);
    if (!wasLoaded) return "\nThe earlier service file was put back.";
    // The earlier unit was already enabled, so it only needs reloading; launchd's bootstrap gets the same retries as install.
    if (t.kind === "launchd") await startService(t, sleep);
    else {
      must(t, "systemctl", [...systemctl, "daemon-reload"]);
      must(t, "systemctl", [...systemctl, "restart", t.id]);
    }
    return "\nThe earlier service was put back and restarted.";
  } catch (err) {
    return `\nPutting the earlier service back failed too: ${(err as Error).message}`;
  }
}

export function uninstallService(o: ServiceOptions): void {
  const t = target(o);
  const copyDir = serviceCopyDir(installedDataDir(t) ?? o.dataDir, t.label);
  const was = existsSync(t.file) || isLoaded(t);
  if (t.kind === "launchd") {
    stop(t);
    rmSync(t.file, { force: true });
  } else if (was) {
    t.run("systemctl", [...systemctl, "disable", "--now", t.id]);
    rmSync(t.file, { force: true });
    t.run("systemctl", [...systemctl, "daemon-reload"]);
  }
  // Only this service's own copy, and only when it says it is one; the older <dataDir>/app layout is left alone.
  const removedCopy = was && isOurCopy(copyDir, t.label);
  if (removedCopy) rmSync(copyDir, { recursive: true, force: true });
  t.log(was ? "Slipstream no longer starts at login, and the copy that was running has stopped." : "Slipstream wasn't set to start at login.");
  // `connect` points Claude Code and Codex at that copy, which is gone now.
  if (removedCopy) t.log(`If you connected Claude Code or Codex with \`${o.self} connect\`, it pointed at that copy. Run \`${o.self} connect claude\` (or \`codex\`) again.`);
}

/**
 * The script the installed login service runs, when there is a service and the script is still there: the copy of Slipstream
 * under the data folder, which npm's cache cleaning can't take away and which needs no network, or the install it was set up
 * from. `connect` points assistants at it instead of at npx's cache.
 */
export function installedServiceBin(o: Pick<ServiceOptions, "port" | "platform" | "home">): string | null {
  try {
    const platform = o.platform ?? process.platform;
    const file = serviceFile(o.port, platform, o.home);
    if (!file || !existsSync(file)) return null;
    const bin = readServiceFile(platform === "darwin" ? "launchd" : "systemd", readFileSync(file, "utf8")).program[1];
    return bin && existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Is `a` an older version than `b`? Compared as numbers, dot by dot; anything that isn't a number says no. */
function isOlder(a: string, b: string): boolean {
  const parts = (v: string) => v.split(".").map((p) => /^\d+/.exec(p)?.[0]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [m, n] = [x[i] ?? "0", y[i] ?? "0"];
    if (!/^\d+$/.test(m) || !/^\d+$/.test(n)) return false;
    if (Number(m) !== Number(n)) return Number(m) < Number(n);
  }
  return false;
}

/** The version the installed service runs: from its app copy's marker, or the package.json of the program it points at. */
function serviceVersion(t: Target, o: ServiceOptions): string | null {
  try {
    const bin = readServiceFile(t.kind, readFileSync(t.file, "utf8")).program[1];
    if (!bin) return null;
    const copy = serviceCopyDir(installedDataDir(t) ?? o.dataDir, t.label);
    if (bin.startsWith(`${copy}${sep}`)) return readMarker(copy)?.version ?? null;
    return (JSON.parse(readFileSync(join(packageRoot(bin), "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export async function serviceStatus(o: ServiceOptions): Promise<{ installed: boolean; loaded: boolean; answering: boolean; version: string | null }> {
  const t = target(o);
  const url = `http://127.0.0.1:${o.port}`;
  const installed = existsSync(t.file);
  const dataDir = installedDataDir(t);
  if (dataDir) t.logPath = join(dataDir, "logs", "server.log");
  const loaded = isLoaded(t);
  const answering = (await o.probe(`${url}/api/health`)) === "slipstream";
  const version = installed ? serviceVersion(t, o) : null;
  const yes = (b: boolean) => (b ? "yes" : "no");
  t.log(`Starts at login: ${installed ? `yes (${t.file})` : `no. Turn it on with \`${o.self} service install\``}`);
  if (version) t.log(`Service version: ${version}`);
  t.log(`Running as a service: ${yes(loaded)}`);
  t.log(`Answering at ${url}: ${yes(answering)}`);
  t.log(`Logs: ${t.logPath}`);
  const current = o.version ?? packageVersion();
  if (version && isOlder(version, current)) t.log(`The service runs ${version}; you're running ${current}. Run \`${o.self} service install\` to update it.`);
  return { installed, loaded, answering, version };
}
