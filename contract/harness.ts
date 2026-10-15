/**
 * Black-box harness for the Slipstream contract suite. The tests only speak HTTP and MCP, so the same
 * suite can certify any server implementation.
 *
 *   SLIPSTREAM_CONTRACT_URL=http://127.0.0.1:4380 npm run test:contract   # an already-running local-mode server
 *   npm run test:contract                                                  # starts its own (demo inbox)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Server {
  url: string;
  dataDir: string | null;
  stop(): Promise<void>;
}

export async function startServer(opts: { mode?: "local" | "team" } = {}): Promise<Server> {
  const mode = opts.mode ?? "local";
  const external = mode === "team" ? process.env.SLIPSTREAM_CONTRACT_TEAM_URL : process.env.SLIPSTREAM_CONTRACT_URL;
  if (external) return { url: external.replace(/\/$/, ""), dataDir: null, stop: async () => {} };

  const dataDir = mkdtempSync(join(tmpdir(), "slipstream-contract-"));
  const port = 4600 + Math.floor(Math.random() * 300);
  const child: ChildProcess = spawn(process.execPath, ["server/src/main.ts"], {
    env: {
      ...process.env,
      SLIPSTREAM_DATA_DIR: dataDir,
      SLIPSTREAM_PORT: String(port),
      PORT: String(port),
      SLIPSTREAM_MODE: mode,
      SLIPSTREAM_DEMO: "1",
      SLIPSTREAM_SYNC_SECONDS: "3600",
      ...(mode === "team" ? { SLIPSTREAM_SECRET: "contract-secret", SLIPSTREAM_PUBLIC_URL: `http://127.0.0.1:${port}`, SLIPSTREAM_HOST: "127.0.0.1" } : {}),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    dataDir,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The dashboard's own client: same-origin, with the client header (and a session cookie in team mode). */
export function human(base: string, cookie?: string) {
  return async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-slipstream", "1");
    if (cookie) headers.set("cookie", cookie);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const res = await fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

/** An agent: bearer token, no browser headers. */
export function agent(base: string, token: string) {
  return async (path: string, json?: unknown, method = json === undefined ? "GET" : "POST") => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
}

export async function makeAgent(base: string, name: string, scopes: string[], policy?: Record<string, unknown>) {
  const r = await human(base)("/api/agents", { method: "POST", json: { name, scopes, policy } });
  if (r.status !== 200) throw new Error(`creating agent failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { agent: { id: string; name: string }; token: string };
}
