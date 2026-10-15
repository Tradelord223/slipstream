import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import type { AppContext } from "../src/context.ts";
import { createApp } from "../src/http/app.ts";
import { createContext } from "../src/main.ts";
import { newId } from "../src/lib/crypto.ts";
import type { Address, IncomingMessage } from "../src/mail/types.ts";

export interface TestEnv {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  dir: string;
  cleanup(): void;
  /** Fetch against the app as a same-origin browser client would. */
  api(path: string, init?: RequestInit & { json?: unknown; cookie?: string }): Promise<Response>;
}

export function makeEnv(overrides: Partial<Config> = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "slipstream-test-"));
  const port = 4399;
  const config = loadConfig({
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    allowedHosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
    demo: false,
    ...overrides,
  });
  const ctx = createContext(config);
  if (config.mode === "local") ctx.users.ensureLocalUser();
  const app = createApp(ctx);
  return {
    ctx,
    app,
    dir,
    cleanup() {
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    api(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("host")) headers.set("host", `127.0.0.1:${port}`);
      if (!headers.has("x-slipstream")) headers.set("x-slipstream", "1");
      if (init.cookie) headers.set("cookie", init.cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
      }
      return Promise.resolve(app.fetch(new Request(`http://127.0.0.1:${port}${path}`, { ...init, headers, body })));
    },
  };
}

export function addAccount(ctx: AppContext, userId: string, email = "me@example.test", provider = "demo"): string {
  const id = newId("acc");
  ctx.db.run(
    "INSERT INTO accounts (id, user_id, provider, email, name, created_at) VALUES (?,?,?,?,?,?)",
    id,
    userId,
    provider,
    email,
    "Me",
    Date.now(),
  );
  return id;
}

let seq = 0;
export function msg(partial: Partial<IncomingMessage> & { from: Address }): IncomingMessage {
  seq += 1;
  return {
    remoteId: `m${seq}`,
    messageIdHeader: `<m${seq}@test>`,
    to: [{ name: "Me", email: "me@example.test" }],
    cc: [],
    bcc: [],
    subject: `Subject ${seq}`,
    sentAt: Date.now() - seq * 1000,
    bodyText: `Body ${seq}`,
    unread: true,
    starred: false,
    folders: { inbox: true, sent: false, trash: false, spam: false },
    attachments: [],
    ...partial,
  };
}
