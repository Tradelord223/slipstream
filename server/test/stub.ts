import type { Config } from "../src/config.ts";
import type { ProviderContext } from "../src/mail/types.ts";

/** Test helpers: a fetch stub with a tiny router, plus config, context and RFC 822 builders. */

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

type Handler = (call: Call) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function empty(status = 204): Response {
  return new Response(null, { status });
}

export class FetchStub {
  readonly calls: Call[] = [];
  private routes: { method: string; match: string | RegExp; handler: Handler }[] = [];
  private original = globalThis.fetch;

  constructor() {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = init?.body;
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        url,
        headers: new Headers(init?.headers),
        body: typeof body === "string" ? body : "",
      };
      this.calls.push(call);
      const target = `${url.origin}${url.pathname}`;
      const route = this.routes.find((r) => r.method === call.method && (typeof r.match === "string" ? target === r.match : r.match.test(target)));
      if (!route) throw new Error(`Unexpected request: ${call.method} ${url.href}`);
      return route.handler(call);
    }) as typeof fetch;
  }

  /** Match on `origin + pathname` (query excluded), exactly for a string or by pattern. */
  on(method: string, match: string | RegExp, handler: Handler | Response | object): this {
    const h: Handler = typeof handler === "function" ? (handler as Handler) : handler instanceof Response ? () => handler.clone() : () => json(handler);
    this.routes.push({ method, match, handler: h });
    return this;
  }

  callsTo(method: string, match: string | RegExp): Call[] {
    return this.calls.filter((c) => {
      const target = `${c.url.origin}${c.url.pathname}`;
      return c.method === method && (typeof match === "string" ? target === match : match.test(target));
    });
  }

  restore(): void {
    globalThis.fetch = this.original;
  }
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    mode: "local",
    host: "127.0.0.1",
    port: 4380,
    publicUrl: "http://127.0.0.1:4380",
    dataDir: "/nonexistent",
    dbPath: "/nonexistent/slipstream.db",
    allowedHosts: new Set(),
    undoSendSeconds: 10,
    google: { clientId: "g-client", clientSecret: "g-secret" },
    microsoft: { clientId: "m-client", clientSecret: undefined, tenant: "common" },
    demo: false,
    syncIntervalSeconds: 60,
    ...over,
  };
}

export function testCtx(over: Partial<ProviderContext> = {}): ProviderContext & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    accountId: "acc1",
    email: "me@example.com",
    auth: { accessToken: "tok-1", refreshToken: "ref-1", expiresAt: Date.now() + 3_600_000 },
    saveAuth: (a) => saved.push(a),
    initialSyncDays: 120,
    ...over,
    saved,
  };
}

export interface MailSpec {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  date?: string;
  body?: string;
}

export function rawMail(spec: MailSpec = {}): Buffer {
  const lines = [
    `From: ${spec.from ?? "Ann <ann@example.org>"}`,
    `To: ${spec.to ?? "me@example.com"}`,
    `Subject: ${spec.subject ?? "Hello"}`,
    `Message-ID: ${spec.messageId ?? "<a1@example.org>"}`,
    ...(spec.inReplyTo ? [`In-Reply-To: ${spec.inReplyTo}`, `References: ${spec.inReplyTo}`] : []),
    `Date: ${spec.date ?? "Tue, 06 Oct 2026 09:00:00 +0000"}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    spec.body ?? "Hi there",
    "",
  ];
  return Buffer.from(lines.join("\r\n"));
}
