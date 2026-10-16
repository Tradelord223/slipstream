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
  openaiApiKey?: string;
  geminiApiKey?: string;
  openrouterApiKey?: string;
  /** Seed a demo account on first boot (local mode only). */
  demo: boolean;
  syncIntervalSeconds: number;
  /** `SLIPSTREAM_SENDER_LOGOS=off` turns sender logos off for the whole server, whatever people choose in Settings. */
  senderLogos: boolean;
  /**
   * Where users can get this server's source (AGPL-3.0 section 13). Point it at your fork if you run a
   * modified Slipstream for others.
   */
  sourceUrl: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** Public URL from the hosting platform, so a one-click deploy works without extra settings. */
function platformUrl(): string | undefined {
  if (env("FLY_APP_NAME")) return `https://${env("FLY_APP_NAME")}.fly.dev`;
  if (env("RENDER_EXTERNAL_URL")) return env("RENDER_EXTERNAL_URL");
  if (env("RAILWAY_PUBLIC_DOMAIN")) return `https://${env("RAILWAY_PUBLIC_DOMAIN")}`;
  return undefined;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const mode: Mode = env("SLIPSTREAM_MODE") === "team" ? "team" : "local";
  const port = Number(env("PORT") ?? env("SLIPSTREAM_PORT") ?? 4380);
  // Local mode never listens beyond loopback: it holds mail credentials and has no login.
  const host = mode === "local" ? "127.0.0.1" : (env("SLIPSTREAM_HOST") ?? "0.0.0.0");
  const publicUrl = (env("SLIPSTREAM_PUBLIC_URL") ?? platformUrl() ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
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
    openaiApiKey: env("OPENAI_API_KEY"),
    geminiApiKey: env("GEMINI_API_KEY") ?? env("GOOGLE_API_KEY"),
    openrouterApiKey: env("OPENROUTER_API_KEY"),
    demo: mode === "local" && env("SLIPSTREAM_DEMO") !== "0",
    syncIntervalSeconds: Number(env("SLIPSTREAM_SYNC_SECONDS") ?? 60),
    senderLogos: env("SLIPSTREAM_SENDER_LOGOS")?.toLowerCase() !== "off",
    sourceUrl: env("SLIPSTREAM_SOURCE_URL") ?? "https://github.com/Tradelord223/slipstream",
    ...overrides,
  };
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return config;
}
