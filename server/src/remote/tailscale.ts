import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

/**
 * Sharing Slipstream's MCP endpoint over Tailscale, without a hosting provider:
 * - Serve: an HTTPS address only your own devices (your tailnet) can reach.
 * - Funnel: a public HTTPS address, for assistants that call from the cloud (claude.ai, ChatGPT).
 * Both point at the public listener, which only serves /mcp, /oauth and /.well-known; never the dashboard.
 */

const run = promisify(execFile);

export interface TailscaleState {
  installed: boolean;
  running: boolean;
  dnsName: string | null;
  serve: { url: string } | null;
  funnel: { url: string } | null;
  error?: string;
}

export type ShareMode = "serve" | "funnel" | "off";

const CANDIDATES = [
  process.env.SLIPSTREAM_TAILSCALE_BIN,
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
].filter((p): p is string => Boolean(p));

export function tailscaleBinary(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

async function ts(args: string[]): Promise<string> {
  const bin = tailscaleBinary();
  if (!bin) throw new Error("Tailscale isn't installed");
  const { stdout } = await run(bin, args, { timeout: 15_000 });
  return stdout;
}

/** Which of our port's routes Serve/Funnel currently expose, read from `tailscale serve status --json`. */
function exposures(statusJson: string, port: number): { serve: boolean; funnel: boolean } {
  const target = `127.0.0.1:${port}`;
  try {
    const s = JSON.parse(statusJson || "{}") as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      AllowFunnel?: Record<string, boolean>;
    };
    let serve = false;
    let funnel = false;
    for (const [hostPort, web] of Object.entries(s.Web ?? {})) {
      const points = Object.values(web.Handlers ?? {}).some((h) => (h.Proxy ?? "").includes(target));
      if (!points) continue;
      if (s.AllowFunnel?.[hostPort]) funnel = true;
      else serve = true;
    }
    return { serve, funnel };
  } catch {
    return { serve: false, funnel: false };
  }
}

export async function tailscaleState(publicPort: number): Promise<TailscaleState> {
  if (!tailscaleBinary()) return { installed: false, running: false, dnsName: null, serve: null, funnel: null };
  try {
    const status = JSON.parse(await ts(["status", "--json"])) as { BackendState?: string; Self?: { DNSName?: string } };
    const running = status.BackendState === "Running";
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "") || null;
    if (!running || !dnsName) return { installed: true, running, dnsName, serve: null, funnel: null };
    const ex = exposures(await ts(["serve", "status", "--json"]).catch(() => "{}"), publicPort);
    const url = `https://${dnsName}`;
    return { installed: true, running, dnsName, serve: ex.serve ? { url } : null, funnel: ex.funnel ? { url } : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      installed: true,
      running: false,
      dnsName: null,
      serve: null,
      funnel: null,
      error: /connect to local Tailscale service|is Tailscale running/i.test(message) ? "Tailscale isn't running. Open Tailscale and sign in." : message,
    };
  }
}

/** Point HTTPS :443 on this machine's tailnet name at the public listener, privately (serve) or publicly (funnel). */
export async function share(mode: ShareMode, publicPort: number): Promise<TailscaleState> {
  const target = `http://127.0.0.1:${publicPort}`;
  // Never disturb something else the person serves on :443; only replace our own mapping.
  const status = await ts(["serve", "status", "--json"]).catch(() => "{}");
  const ours = exposures(status, publicPort);
  const busy = Object.keys((JSON.parse(status || "{}") as { Web?: object }).Web ?? {}).some((hp) => hp.endsWith(":443"));
  if (busy && !ours.serve && !ours.funnel) throw new Error("Tailscale is already serving something else on port 443. Turn that off first.");
  // A port is either Serve or Funnel; clear ours before switching.
  if (ours.funnel) await ts(["funnel", "--https=443", "off"]);
  if (ours.serve) await ts(["serve", "--https=443", "off"]);
  if (mode === "serve") await ts(["serve", "--bg", "--https=443", target]);
  if (mode === "funnel") await ts(["funnel", "--bg", "--https=443", target]);
  return tailscaleState(publicPort);
}
