import type { Config } from "../config.ts";

/** OAuth flows for Google and Microsoft (authorization code + PKCE). Placeholder until the connectors land. */
export interface OAuthResult {
  auth: unknown;
  email: string;
  name: string;
}

export function googleRedirectUri(config: Config): string {
  return `${config.publicUrl}/api/oauth/google/callback`;
}

/** Microsoft only accepts http://localhost (any port) for loopback redirects, not 127.0.0.1. */
export function microsoftRedirectUri(config: Config): string {
  if (config.mode === "local") return `http://localhost:${config.port}/api/oauth/microsoft/callback`;
  return `${config.publicUrl}/api/oauth/microsoft/callback`;
}

export function googleAuthUrl(_config: Config, _state: string, _codeChallenge: string): string {
  throw new Error("Google sign-in is not implemented yet");
}

export async function googleExchange(_config: Config, _code: string, _verifier: string): Promise<OAuthResult> {
  throw new Error("Google sign-in is not implemented yet");
}

export function microsoftAuthUrl(_config: Config, _state: string, _codeChallenge: string): string {
  throw new Error("Microsoft sign-in is not implemented yet");
}

export async function microsoftExchange(_config: Config, _code: string, _verifier: string): Promise<OAuthResult> {
  throw new Error("Microsoft sign-in is not implemented yet");
}
