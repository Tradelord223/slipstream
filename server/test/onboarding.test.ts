import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { loadConfig, microsoftApp } from "../src/config.ts";
import type { ServerEvent } from "../src/events.ts";
import { createApp } from "../src/http/app.ts";
import type { AccountDeps } from "../src/http/accounts.ts";
import type { MailProvider, SyncPage } from "../src/mail/types.ts";
import { DEMO_IDENTITY } from "../src/providers/demo.ts";
import { discover, type DnsLookup, type MxRecord, type SrvRecord } from "../src/providers/discover.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";
import { microsoftExchange } from "../src/providers/oauth.ts";
import { FetchStub, testConfig } from "./stub.ts";

const envs: TestEnv[] = [];
const fresh = (over: Parameters<typeof makeEnv>[0] = {}) => {
  const e = makeEnv(over);
  envs.push(e);
  return e;
};
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

/** A resolver that answers from tables; anything not in them is "no such record". */
function dnsOf(mx: Record<string, MxRecord[]> = {}, srv: Record<string, SrvRecord[]> = {}): DnsLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveMx(domain) {
      calls.push(`MX ${domain}`);
      const r = mx[domain];
      if (!r) throw Object.assign(new Error(`queryMx ENODATA ${domain}`), { code: "ENODATA" });
      return r;
    },
    async resolveSrv(name) {
      calls.push(`SRV ${name}`);
      const r = srv[name];
      if (!r) throw Object.assign(new Error(`querySrv ENOTFOUND ${name}`), { code: "ENOTFOUND" });
      return r;
    },
  };
}

describe("the demo mailbox is developer-only", () => {
  const saved = process.env.SLIPSTREAM_DEMO;
  afterEach(() => {
    if (saved === undefined) delete process.env.SLIPSTREAM_DEMO;
    else process.env.SLIPSTREAM_DEMO = saved;
  });
  const load = () => loadConfig({ dataDir: fresh().dir }).demo;

  test("is off by default", () => {
    delete process.env.SLIPSTREAM_DEMO;
    assert.equal(load(), false);
  });

  test("is on with SLIPSTREAM_DEMO=1, and only then", () => {
    process.env.SLIPSTREAM_DEMO = "1";
    assert.equal(load(), true);
    process.env.SLIPSTREAM_DEMO = "0";
    assert.equal(load(), false);
  });

  test("stays off in team mode", () => {
    process.env.SLIPSTREAM_DEMO = "1";
    process.env.SLIPSTREAM_MODE = "team";
    try {
      assert.equal(load(), false);
    } finally {
      delete process.env.SLIPSTREAM_MODE;
    }
  });
});

describe("Microsoft app", () => {
  const keys = ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("with no client id configured and no built-in app, Microsoft sign-in is off", () => {
    for (const k of keys) delete process.env[k];
    const config = loadConfig({ dataDir: fresh().dir });
    assert.equal(config.microsoft.clientId, undefined);
  });

  test("an operator's own app is used with its secret", () => {
    process.env.MICROSOFT_CLIENT_ID = "own-app";
    process.env.MICROSOFT_CLIENT_SECRET = "own-secret";
    const config = loadConfig({ dataDir: fresh().dir });
    assert.deepEqual([config.microsoft.clientId, config.microsoft.clientSecret], ["own-app", "own-secret"]);
  });
});

describe("Slipstream's built-in Microsoft app", () => {
  const saved = process.env.MICROSOFT_CLIENT_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.MICROSOFT_CLIENT_SECRET;
    else process.env.MICROSOFT_CLIENT_SECRET = saved;
  });

  test("local mode uses it, drops a stray secret meant for another app, and sends no client_secret", async () => {
    process.env.MICROSOFT_CLIENT_SECRET = "someone-elses-secret";
    const app = microsoftApp("local", "built-in-id");
    assert.deepEqual([app.clientId, app.clientSecret, app.tenant], ["built-in-id", undefined, "common"]);

    const stub = new FetchStub()
      .on("POST", "https://login.microsoftonline.com/common/oauth2/v2.0/token", { access_token: "at", refresh_token: "rt", expires_in: 3600 })
      .on("GET", "https://graph.microsoft.com/v1.0/me", { mail: "jordan@fernpoint.co", displayName: "Jordan" });
    try {
      await microsoftExchange(testConfig({ microsoft: app }), "code", "verifier");
      const form = new URLSearchParams(stub.calls[0]!.body);
      assert.equal(form.get("client_id"), "built-in-id");
      assert.equal(form.has("client_secret"), false);
      assert.equal(form.get("redirect_uri"), "http://localhost:4380/api/oauth/microsoft/callback");
    } finally {
      stub.restore();
    }
  });

  test("a team server never gets it: its redirect is not the loopback address", () => {
    assert.equal(microsoftApp("team", "built-in-id").clientId, undefined);
  });
});

describe("bootstrap", () => {
  test("reports the demo flag, each account's first sync, and the onboarded setting", async () => {
    const env = fresh({ demo: true });
    const acc = addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email, "demo");
    let boot = await (await env.api("/api/bootstrap")).json();
    assert.equal(boot.features.demo, true);
    assert.equal(boot.accounts[0].firstSyncedAt, null);
    assert.equal(boot.settings.onboarded, undefined);

    await env.ctx.sync.syncAccount(acc);
    assert.equal((await env.api("/api/settings", { method: "PUT", json: { onboarded: true } })).status, 200);
    boot = await (await env.api("/api/bootstrap")).json();
    assert.equal(typeof boot.accounts[0].firstSyncedAt, "number");
    assert.equal(boot.settings.onboarded, true);
  });

  test("says the demo is off by default and refuses a non-boolean onboarded", async () => {
    const env = fresh();
    assert.equal((await (await env.api("/api/bootstrap")).json()).features.demo, false);
    assert.equal((await env.api("/api/settings", { method: "PUT", json: { onboarded: "yes" } })).status, 400);
  });
});

describe("connecting real mail retires the demo mailbox", () => {
  /** A port nothing listens on, so the background sync after connecting fails fast instead of reaching anywhere. */
  async function closedPort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(r));
    return port;
  }
  const accepted: AccountDeps = { verifyImap: async () => {} };

  async function connect(env: TestEnv, app = createApp(env.ctx, undefined, { accounts: accepted })) {
    const port = await closedPort();
    const res = await app.fetch(
      new Request("http://127.0.0.1:4399/api/accounts/imap", {
        method: "POST",
        headers: { host: "127.0.0.1:4399", "x-slipstream": "1", "content-type": "application/json" },
        body: JSON.stringify({ email: "jordan@fernpoint.co", password: "pw", imapHost: "127.0.0.1", imapPort: port, smtpHost: "127.0.0.1", smtpPort: port }),
      }),
    );
    assert.equal(res.status, 200);
    const { id } = (await res.json()) as { id: string };
    // Let the first sync attempt finish so the database isn't closed under it.
    for (let i = 0; i < 100 && env.ctx.db.get<{ s: string }>("SELECT sync_status AS s FROM accounts WHERE id = ?", id)?.s === "syncing"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return id;
  }

  const providers = (env: TestEnv) => env.ctx.db.all<{ provider: string }>("SELECT provider FROM accounts ORDER BY created_at").map((r) => r.provider);

  test("the first real account replaces the demo one, with its mail and search entries", async () => {
    const env = fresh();
    const demo = addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email, "demo");
    await env.ctx.sync.syncAccount(demo);
    const count = (sql: string) => env.ctx.db.get<{ n: number }>(sql, demo)!.n;
    assert.ok(count("SELECT count(*) AS n FROM threads WHERE account_id = ?") > 0);

    const events: ServerEvent[] = [];
    env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => events.push(e));
    await connect(env);

    assert.deepEqual(providers(env), ["imap"]);
    assert.equal(count("SELECT count(*) AS n FROM messages WHERE account_id = ?"), 0);
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'fernpoint'")?.n ?? 0, 0);
    const told = events.find((e) => e.type === "threads" && e.accountId === demo);
    assert.ok(told && told.type === "threads" && told.threadIds.length > 0, "the client is told which threads went");
    assert.equal((await (await env.api("/api/bootstrap")).json()).accounts.length, 1);
  });

  test("removing an account that has synced mail works, and clears its search entries", async () => {
    const env = fresh();
    const acc = addAccount(env.ctx, LOCAL_USER_ID, "jordan@fernpoint.co", "demo");
    await env.ctx.sync.syncAccount(acc);
    const indexed = () => env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages_fts")!.n;
    assert.ok(indexed() > 0);
    const res = await env.api(`/api/accounts/${acc}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(indexed(), 0);
    // Deleting from the search index used to leave every later write failing until the next insert.
    env.ctx.db.run("UPDATE accounts SET name = name");
    assert.equal(env.ctx.db.get("SELECT 1 AS x FROM accounts WHERE id = ?", acc), undefined);
  });

  test("removing an account with a few hundred synced messages works too", async () => {
    const env = fresh();
    const acc = addAccount(env.ctx, LOCAL_USER_ID, "jordan@fernpoint.co", "imap");
    const from = { name: "Sam", email: "sam@fernpoint.co" };
    const pages: SyncPage[] = [
      { messages: Array.from({ length: 240 }, () => msg({ from })), cursor: "1", done: true },
    ];
    env.ctx.sync.provider = () => ({ kind: "imap", sync: async () => pages.shift()! }) as unknown as MailProvider;
    await env.ctx.sync.syncAccount(acc);
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE account_id = ?", acc)!.n, 240);
    assert.equal((await env.api(`/api/accounts/${acc}`, { method: "DELETE" })).status, 200);
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages_fts")!.n, 0);
  });

  test("an import counts as real mail too", async () => {
    const env = fresh();
    addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email, "demo");
    const done = new Promise<void>((resolve) => {
      env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => e.type === "import" && e.status === "done" && resolve());
    });
    const form = new FormData();
    form.append("file", new File(["From a@fernpoint.co Mon Jan  1 00:00:00 2024\nFrom: a@fernpoint.co\nTo: me@fernpoint.co\nSubject: Hello\n\nHi\n"], "old.mbox"));
    form.append("email", "me@fernpoint.co");
    assert.equal((await env.api("/api/import", { method: "POST", body: form })).status, 200);
    await done;
    assert.deepEqual(providers(env), ["archive"]);
  });

  test("developer demo mode keeps the demo mailbox beside the real one", async () => {
    const env = fresh({ demo: true });
    addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email, "demo");
    await connect(env);
    assert.deepEqual(providers(env), ["demo", "imap"]);
  });

  test("a failed sign-in leaves the demo mailbox alone", async () => {
    const env = fresh();
    addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email, "demo");
    const app = createApp(env.ctx, undefined, {
      accounts: { verifyImap: async () => Promise.reject(new Error("wrong password")) },
    });
    const res = await app.fetch(
      new Request("http://127.0.0.1:4399/api/accounts/imap", {
        method: "POST",
        headers: { host: "127.0.0.1:4399", "x-slipstream": "1", "content-type": "application/json" },
        body: JSON.stringify({ email: "jordan@fernpoint.co", password: "bad", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }),
      }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(providers(env), ["demo"]);
  });
});

describe("address discovery", () => {
  const config = testConfig({ google: { clientId: "g-client" }, microsoft: { clientId: "m-client", tenant: "common" } });
  const noDnsAtAll = dnsOf();

  test("known consumer domains are answered without asking DNS", async () => {
    const cases: [string, string, string | null, string | null][] = [
      ["a@gmail.com", "gmail", "gmail", "google"],
      ["a@googlemail.com", "gmail", "gmail", "google"],
      ["a@outlook.com", "outlook", null, "microsoft"],
      ["a@hotmail.co.uk", "outlook", null, "microsoft"],
      ["a@live.fr", "outlook", null, "microsoft"],
      ["a@msn.com", "outlook", null, "microsoft"],
      ["a@icloud.com", "icloud", "icloud", null],
      ["a@me.com", "icloud", "icloud", null],
      ["a@yahoo.com.au", "yahoo", "yahoo", null],
      ["a@ymail.com", "yahoo", "yahoo", null],
      ["a@fastmail.fm", "fastmail", "fastmail", null],
      ["a@zoho.com", "zoho", "zoho", null],
      ["a@pm.me", "proton", "proton", null],
    ];
    for (const [email, provider, preset, oauth] of cases) {
      const d = await discover(email, config, { dns: noDnsAtAll });
      assert.deepEqual([d.provider, d.preset, d.oauth, d.source, d.servers], [provider, preset, oauth, "preset", null], email);
    }
    assert.deepEqual(noDnsAtAll.calls, []);
  });

  test("one-click sign-in is only offered when this install has that app", async () => {
    const bare = testConfig({ google: {}, microsoft: { tenant: "common" } });
    assert.equal((await discover("a@gmail.com", bare, { dns: noDnsAtAll })).oauth, null);
    assert.equal((await discover("a@outlook.com", bare, { dns: noDnsAtAll })).oauth, null);
  });

  test("a lookalike subdomain of a consumer brand is not mistaken for it", async () => {
    const dns = dnsOf();
    const d = await discover("a@live.fernpoint.co", config, { dns });
    assert.equal(d.source, "none");
    assert.ok(dns.calls.length > 0, "it was looked up, not assumed");
  });

  test("Yahoo Japan is not the Yahoo preset", async () => {
    assert.equal((await discover("a@yahoo.co.jp", config, { dns: dnsOf() })).source, "none");
  });

  test("a Google Workspace domain is found by its MX records", async () => {
    const dns = dnsOf({ "fernpoint.co": [{ exchange: "alt1.aspmx.l.google.com", priority: 5 }, { exchange: "aspmx.l.google.com", priority: 1 }] });
    assert.deepEqual(await discover("jordan@fernpoint.co", config, { dns }), {
      email: "jordan@fernpoint.co",
      domain: "fernpoint.co",
      provider: "gmail",
      preset: "gmail",
      oauth: "google",
      servers: null,
      source: "mx",
    });
  });

  test("a Microsoft 365 domain is found by its MX records", async () => {
    const dns = dnsOf({ "fernpoint.co": [{ exchange: "fernpoint-co.mail.protection.outlook.com.", priority: 0 }] });
    const d = await discover("jordan@fernpoint.co", config, { dns });
    assert.deepEqual([d.provider, d.preset, d.oauth, d.source], ["outlook", null, "microsoft", "mx"]);
  });

  test("other hosts are found by MX too, and Zoho outside zoho.com has no preset", async () => {
    const via = async (exchange: string) => (await discover("a@fernpoint.co", config, { dns: dnsOf({ "fernpoint.co": [{ exchange, priority: 10 }] }) }));
    assert.equal((await via("in1-smtp.messagingengine.com")).provider, "fastmail");
    assert.equal((await via("mx01.mail.icloud.com")).provider, "icloud");
    assert.equal((await via("mta5.am0.yahoodns.net")).provider, "yahoo");
    const zoho = await via("mx.zoho.com");
    assert.deepEqual([zoho.provider, zoho.preset], ["zoho", "zoho"]);
    const eu = await via("mx.zoho.eu");
    assert.deepEqual([eu.provider, eu.preset], ["zoho", null]);
  });

  test("an unrecognised mail host falls through to the domain's SRV records", async () => {
    const dns = dnsOf(
      { "fernpoint.co": [{ exchange: "mail.fernpoint.co", priority: 10 }] },
      {
        "_imaps._tcp.fernpoint.co": [{ name: "imap.hosting.example.", port: 993, priority: 10, weight: 1 }, { name: "backup.hosting.example", port: 993, priority: 20, weight: 1 }],
        "_submission._tcp.fernpoint.co": [{ name: "smtp.hosting.example", port: 587, priority: 0, weight: 5 }],
      },
    );
    assert.deepEqual(await discover("jordan@fernpoint.co", config, { dns }), {
      email: "jordan@fernpoint.co",
      domain: "fernpoint.co",
      provider: "imap",
      preset: null,
      oauth: null,
      servers: { imapHost: "imap.hosting.example", imapPort: 993, imapSecure: true, smtpHost: "smtp.hosting.example", smtpPort: 587, smtpSecure: false },
      source: "srv",
    });
  });

  test("SRV needs both an inbox and an outbox, and a '.' target means not offered", async () => {
    const onlyInbox = dnsOf({}, { "_imaps._tcp.fernpoint.co": [{ name: "imap.hosting.example", port: 993, priority: 0, weight: 0 }] });
    assert.equal((await discover("a@fernpoint.co", config, { dns: onlyInbox })).source, "none");
    const declined = dnsOf(
      {},
      {
        "_imaps._tcp.fernpoint.co": [{ name: ".", port: 0, priority: 0, weight: 0 }],
        "_submissions._tcp.fernpoint.co": [{ name: ".", port: 0, priority: 0, weight: 0 }],
      },
    );
    assert.equal((await discover("a@fernpoint.co", config, { dns: declined })).source, "none");
  });

  test("an unknown domain is a plain IMAP account with no server names", async () => {
    const d = await discover("jordan@fernpoint.co", config, { dns: dnsOf() });
    assert.deepEqual([d.provider, d.preset, d.oauth, d.servers, d.source], ["imap", null, null, null, "none"]);
  });

  test("a resolver that never answers gives 'none' once the timeout passes, not an error", async () => {
    const hang = new Promise<never>(() => {});
    const dns: DnsLookup = { resolveMx: () => hang, resolveSrv: () => hang };
    const started = Date.now();
    const d = await discover("jordan@fernpoint.co", config, { dns, timeoutMs: 40 });
    assert.equal(d.source, "none");
    assert.ok(Date.now() - started < 1500);
  });

  describe("the route", () => {
    const callRoute = (env: TestEnv, deps: AccountDeps, email: string | null) => {
      const app = createApp(env.ctx, undefined, { accounts: deps });
      const q = email === null ? "" : `?email=${encodeURIComponent(email)}`;
      return app.fetch(new Request(`http://127.0.0.1:4399/api/accounts/discover${q}`, { headers: { host: "127.0.0.1:4399", "x-slipstream": "1" } }));
    };

    test("returns the discovery for a signed-in user", async () => {
      const env = fresh({ google: { clientId: "g-client" } });
      const dns = dnsOf({ "fernpoint.co": [{ exchange: "aspmx.l.google.com", priority: 1 }] });
      const res = await callRoute(env, { discover: { dns } }, "Jordan@Fernpoint.co");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual([body.domain, body.provider, body.oauth, body.source], ["fernpoint.co", "gmail", "google", "mx"]);
    });

    test("an address that isn't one is a 400", async () => {
      const env = fresh();
      for (const bad of ["", "nobody", "a@", "@fernpoint.co", "a b@fernpoint.co"]) {
        assert.equal((await callRoute(env, { discover: { dns: dnsOf() } }, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await callRoute(env, { discover: { dns: dnsOf() } }, null)).status, 400);
    });

    test("needs a session in team mode", async () => {
      const env = fresh({ mode: "team" });
      assert.equal((await callRoute(env, {}, "a@gmail.com")).status, 401);
    });

    test("too many lookups at once are turned away rather than queued", async () => {
      const env = fresh();
      const waiting: (() => void)[] = [];
      const dns: DnsLookup = {
        resolveMx: () => new Promise<MxRecord[]>((resolve) => waiting.push(() => resolve([]))),
        resolveSrv: async () => [],
      };
      const app = createApp(env.ctx, undefined, { accounts: { discover: { dns, timeoutMs: 10_000 } } });
      const ask = (email: string) =>
        app.fetch(new Request(`http://127.0.0.1:4399/api/accounts/discover?email=${email}`, { headers: { host: "127.0.0.1:4399", "x-slipstream": "1" } }));
      const open = Array.from({ length: 8 }, (_, i) => ask(`a@fernpoint${i}.co`));
      for (let i = 0; i < 200 && waiting.length < 8; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(waiting.length, 8);
      assert.equal((await ask("a@fernpoint9.co")).status, 429);
      for (const release of waiting) release();
      assert.ok((await Promise.all(open)).every((r) => r.status === 200));
      assert.equal((await ask("a@gmail.com")).status, 200, "and it frees up again");
    });
  });
});

describe("first-sync progress", () => {
  test("each page that stores mail reports a growing 'fetched' count", async () => {
    const env = fresh();
    const acc = addAccount(env.ctx, LOCAL_USER_ID, "me@fernpoint.co", "imap");
    const from = { name: "Sam", email: "sam@fernpoint.co" };
    const pages: SyncPage[] = [
      { messages: [msg({ from }), msg({ from }), msg({ from })], cursor: "1", done: false },
      { messages: [msg({ from }), msg({ from })], cursor: "2", done: false },
      { messages: [], cursor: "3", done: true },
    ];
    const fake = { kind: "imap", sync: async () => pages.shift()! } as unknown as MailProvider;
    env.ctx.sync.provider = () => fake;

    const events: ServerEvent[] = [];
    env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => events.push(e));
    await env.ctx.sync.syncAccount(acc);

    const syncing = events.filter((e) => e.type === "sync" && e.status === "syncing");
    assert.deepEqual(
      syncing.map((e) => (e.type === "sync" ? e.fetched : undefined)),
      [undefined, 3, 5],
      "the opening 'syncing' has no count; then 3, then 5 so far",
    );
    const last = events.filter((e) => e.type === "sync").at(-1);
    assert.ok(last && last.type === "sync" && last.status === "idle");
  });
});
