import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Mode = "local" | "team";

export interface Config {
  mode: Mode;
  host: string;
  port: number;
  /** Public origin used for OAuth redirects and invite links, e.g. https://mail.example.com */
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  /** Hosts allowed in the Host header. Blocks DNS-rebinding attacks on the local server. */
  allowedHosts: Set<string>;
  undoSendSeconds: number;
  google: { clientId?: string; clientSecret?: string };
  microsoft: { clientId?: string; clientSecret?: string; tenant: string };
  anthropicApiKey?: string;
  /** Seed a demo account on first boot (local mode only). */
  demo: boolean;
  syncIntervalSeconds: number;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const mode: Mode = env("SLIPSTREAM_MODE") === "team" ? "team" : "local";
  const port = Number(env("PORT") ?? env("SLIPSTREAM_PORT") ?? 4380);
  // Local mode never listens beyond loopback: it holds mail credentials and has no login.
  const host = mode === "local" ? "127.0.0.1" : (env("SLIPSTREAM_HOST") ?? "0.0.0.0");
  const publicUrl = (env("SLIPSTREAM_PUBLIC_URL") ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const dataDir = resolve(env("SLIPSTREAM_DATA_DIR") ?? join(homedir(), ".slipstream"));

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  allowedHosts.add(new URL(publicUrl).host);
  for (const h of (env("SLIPSTREAM_ALLOWED_HOSTS") ?? "").split(",")) if (h.trim()) allowedHosts.add(h.trim());

  const config: Config = {
    mode,
    host,
    port,
    publicUrl,
    dataDir,
    dbPath: join(dataDir, "slipstream.db"),
    allowedHosts,
    undoSendSeconds: Number(env("SLIPSTREAM_UNDO_SEND_SECONDS") ?? 10),
    google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
    microsoft: { clientId: env("MICROSOFT_CLIENT_ID"), clientSecret: env("MICROSOFT_CLIENT_SECRET"), tenant: env("MICROSOFT_TENANT") ?? "common" },
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    demo: mode === "local" && env("SLIPSTREAM_DEMO") !== "0",
    syncIntervalSeconds: Number(env("SLIPSTREAM_SYNC_SECONDS") ?? 60),
    ...overrides,
  };
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config;
}
