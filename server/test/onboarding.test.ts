import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { loadConfig, microsoftApp } from "../src/config.ts";
import type { ServerEvent } from "../src/events.ts";
import { importStatus } from "../src/context.ts";
import { createApp } from "../src/http/app.ts";
import { retireDemoMailboxes, type AccountDeps } from "../src/http/accounts.ts";
import type { MailProvider, SyncPage } from "../src/mail/types.ts";
import { DEMO_IDENTITY } from "../src/providers/demo.ts";
import { discover, type DnsLookup, type MxRecord, type SrvRecord } from "../src/providers/discover.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";
import { microsoftExchange } from "../src/providers/oauth.ts";
import { FetchStub, json, testConfig } from "./stub.ts";

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

  async function connect(env: TestEnv, app = createApp(env.ctx, undefined, { accounts: accepted }), extra: Record<string, unknown> = {}) {
    const port = await closedPort();
    const res = await app.fetch(
      new Request("http://127.0.0.1:4399/api/accounts/imap", {
        method: "POST",
        headers: { host: "127.0.0.1:4399", "x-slipstream": "1", "content-type": "application/json" },
        body: JSON.stringify({ email: "jordan@fernpoint.co", password: "pw", imapHost: "127.0.0.1", imapPort: port, smtpHost: "127.0.0.1", smtpPort: port, ...extra }),
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

  test("at startup, a demo mailbox left over from an older version goes once there is real mail", async () => {
    const env = fresh();
    const demo = addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email, "demo");
    await env.ctx.sync.syncAccount(demo);
    assert.ok(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages_fts")!.n > 0);

    // Only the demo mailbox so far: it stays, the person has nothing else.
    await retireDemoMailboxes(env.ctx);
    assert.deepEqual(providers(env), ["demo"]);

    addAccount(env.ctx, LOCAL_USER_ID, "jordan@fernpoint.co", "imap");
    await retireDemoMailboxes(env.ctx);
    assert.deepEqual(providers(env), ["imap"]);
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages_fts")!.n, 0, "its search entries went with it");
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE account_id = ?", demo)!.n, 0);
    await retireDemoMailboxes(env.ctx);
    assert.deepEqual(providers(env), ["imap"], "running it again changes nothing");
  });

  test("at startup, developer demo mode keeps its demo mailbox", async () => {
    const env = fresh({ demo: true });
    addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email, "demo");
    addAccount(env.ctx, LOCAL_USER_ID, "jordan@fernpoint.co", "imap");
    await retireDemoMailboxes(env.ctx);
    assert.deepEqual(providers(env), ["demo", "imap"]);
  });

  test("an IMAP account keeps the preset it was connected with, and reconnecting updates the same account", async () => {
    const env = fresh();
    const app = createApp(env.ctx, undefined, { accounts: accepted });
    const id = await connect(env, app, { preset: "icloud" });
    const shown = async () => ((await (await env.api("/api/bootstrap")).json()).accounts as { id: string; preset: string | null }[]).map((a) => [a.id, a.preset]);
    assert.deepEqual(await shown(), [[id, "icloud"]]);

    // A new app password for the same address: the same account, still iCloud.
    env.ctx.db.run("UPDATE accounts SET sync_status = 'reauth', sync_error = 'bad password' WHERE id = ?", id);
    assert.equal(await connect(env, app, { preset: "icloud", password: "new" }), id);
    assert.deepEqual(await shown(), [[id, "icloud"]]);
    assert.equal(env.ctx.db.get<{ s: string }>("SELECT sync_status AS s FROM accounts WHERE id = ?", id)?.s !== "reauth", true);

    // Typed-in servers have no preset to remember.
    const other = fresh();
    const otherId = await connect(other);
    assert.deepEqual(((await (await other.api("/api/bootstrap")).json()).accounts as { id: string; preset: string | null }[]).map((a) => [a.id, a.preset]), [[otherId, null]]);
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

  test("only the country domains these brands really run are assumed; any other goes through DNS", async () => {
    for (const email of ["a@live.zz", "a@live.io", "a@hotmail.zz", "a@outlook.co.zz", "a@yahoo.zz", "a@yahoo.com.zz"]) {
      const dns = dnsOf();
      const d = await discover(email, config, { dns });
      assert.equal(d.source, "none", email);
      assert.ok(dns.calls.length > 0, `${email} was looked up`);
    }
    // A real Hotmail domain that isn't on the list is still recognised, by its mail exchanger.
    const dns = dnsOf({ "hotmail.nl": [{ exchange: "hotmail-nl.olc.protection.outlook.com", priority: 5 }] });
    const d = await discover("a@hotmail.nl", config, { dns });
    assert.deepEqual([d.provider, d.oauth, d.source], ["outlook", "microsoft", "mx"]);
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
    const jp = await via("mx.zoho.jp");
    assert.deepEqual([jp.provider, jp.preset, jp.servers], ["zoho", null, null]);
  });

  test("Zoho's other regions come back with that region's own servers", async () => {
    for (const tld of ["eu", "in", "com.au"]) {
      const dns = dnsOf({ "fernpoint.co": [{ exchange: `mx.zoho.${tld}`, priority: 10 }, { exchange: `mx2.zoho.${tld}`, priority: 20 }] });
      const d = await discover("a@fernpoint.co", config, { dns });
      assert.deepEqual([d.provider, d.preset, d.source], ["zoho", null, "mx"], tld);
      assert.deepEqual(d.servers, { imapHost: `imap.zoho.${tld}`, imapPort: 993, imapSecure: true, smtpHost: `smtp.zoho.${tld}`, smtpPort: 465, smtpSecure: true }, tld);
    }
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

  test("a resolver that never answers gives 'none' once the timeout passes, not an error, and its queries are cancelled", async () => {
    const hang = new Promise<never>(() => {});
    let cancelled = 0;
    const dns: DnsLookup = { resolveMx: () => hang, resolveSrv: () => hang, cancel: () => void cancelled++ };
    const started = Date.now();
    const d = await discover("jordan@fernpoint.co", config, { dns, timeoutMs: 40 });
    assert.equal(d.source, "none");
    assert.ok(Date.now() - started < 1500);
    assert.ok(cancelled > 0, "the stuck queries were told to stop");
  });

  test("an answer that comes in time cancels nothing", async () => {
    let cancelled = 0;
    const dns = { ...dnsOf({ "fernpoint.co": [{ exchange: "aspmx.l.google.com", priority: 1 }] }), cancel: () => void cancelled++ };
    assert.equal((await discover("jordan@fernpoint.co", config, { dns })).source, "mx");
    assert.equal(cancelled, 0);
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

    /** A resolver whose MX lookups wait until released, so requests stay open. */
    const stalled = () => {
      const waiting: (() => void)[] = [];
      const dns: DnsLookup = {
        resolveMx: () => new Promise<MxRecord[]>((resolve) => waiting.push(() => resolve([]))),
        resolveSrv: async () => [],
      };
      const release = () => waiting.splice(0).forEach((f) => f());
      const settle = async (n: number) => {
        for (let i = 0; i < 200 && waiting.length < n; i++) await new Promise((r) => setTimeout(r, 10));
        assert.equal(waiting.length, n);
      };
      return { dns, release, settle };
    };
    const askAs = (app: ReturnType<typeof createApp>, email: string, cookie?: string) =>
      app.fetch(
        new Request(`http://127.0.0.1:4399/api/accounts/discover?email=${email}`, {
          headers: { host: "127.0.0.1:4399", "x-slipstream": "1", ...(cookie ? { cookie } : {}) },
        }),
      );

    test("one person's fifth simultaneous lookup is turned away rather than queued, and it frees up again", async () => {
      const env = fresh();
      const { dns, release, settle } = stalled();
      const app = createApp(env.ctx, undefined, { accounts: { discover: { dns, timeoutMs: 10_000 } } });
      const open = Array.from({ length: 4 }, (_, i) => askAs(app, `a@fernpoint${i}.co`));
      await settle(4);
      assert.equal((await askAs(app, "a@fernpoint9.co")).status, 429);
      release();
      assert.ok((await Promise.all(open)).every((r) => r.status === 200));
      assert.equal((await askAs(app, "a@gmail.com")).status, 200, "and it frees up again");
    });

    test("one person using their share does not lock out another, but everyone together hit a ceiling", async () => {
      const env = fresh({ mode: "team" });
      const cookies: string[] = [];
      for (let i = 0; i < 5; i++) {
        const u = await env.ctx.users.create(`p${i}@team.test`, `P${i}`, "correct horse battery");
        cookies.push(`slipstream_session=${env.ctx.users.createSession(u.id)}`);
      }
      const { dns, release, settle } = stalled();
      const app = createApp(env.ctx, undefined, { accounts: { discover: { dns, timeoutMs: 10_000 } } });
      const open: (Promise<Response> | Response)[] = [];
      for (const cookie of cookies.slice(0, 4)) for (let i = 0; i < 4; i++) open.push(askAs(app, `a@fernpoint${open.length}.co`, cookie));
      await settle(16);
      assert.equal((await askAs(app, "a@fernpoint90.co", cookies[0])).status, 429, "over their own share");
      assert.equal((await askAs(app, "a@fernpoint91.co", cookies[4])).status, 429, "someone with nothing open, but the total is used up");
      release();
      assert.ok((await Promise.all(open)).every((r) => r.status === 200));
      assert.equal((await askAs(app, "a@gmail.com", cookies[4])).status, 200);
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

describe("importing a mail file", () => {
  /** An mbox of `n` short messages, enough for many 250-message batches. */
  const bigMbox = (n: number) =>
    Array.from({ length: n }, (_, i) => `From a@fernpoint.co Mon Jan  1 00:00:00 2024\nMessage-ID: <i${i}@fernpoint.co>\nFrom: a@fernpoint.co\nTo: me@fernpoint.co\nSubject: Note ${i}\n\nHi\n`).join("\n");
  const startImport = (env: TestEnv, n: number) => {
    const form = new FormData();
    form.append("file", new File([bigMbox(n)], "old.mbox"));
    form.append("email", "me@fernpoint.co");
    return env.api("/api/import", { method: "POST", body: form });
  };
  /** Resolves with the job's last event; `onFirstRunning` runs synchronously inside the first progress event. */
  const terminal = (env: TestEnv, onFirstRunning?: () => void) =>
    new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the import never finished")), 10_000);
      let seen = false;
      env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => {
        if (e.type !== "import") return;
        if (e.status === "running" && !seen) {
          seen = true;
          onFirstRunning?.();
        }
        if (e.status !== "running") {
          clearTimeout(timer);
          resolve(e);
        }
      });
    });
  const firstSynced = (env: TestEnv, id: string) => env.ctx.db.get<{ first_synced_at: number | null }>("SELECT first_synced_at FROM accounts WHERE id = ?", id);

  test("removing the account mid-import ends the job instead of crashing the process", async () => {
    const env = fresh();
    const ended = terminal(env, () => {
      // The same statements as removing the account in Settings, run inside the event so the timing is exact.
      env.ctx.db.run("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'archive'))");
      env.ctx.db.run("DELETE FROM accounts WHERE provider = 'archive'");
    });
    const res = await startImport(env, 1500);
    const accountId = ((await res.json()) as { accountId: string }).accountId;
    const end = await ended;
    assert.equal(end.type === "import" && end.status, "failed");
    assert.match(end.type === "import" ? (end.error ?? "") : "", /removed/);
    // The job has let go of the account, and the process is still here to run this line.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.ctx.imports.size, 0);
    assert.equal(firstSynced(env, accountId), undefined);
  });

  test("an archive is not 'first synced' until its import finishes, and bootstrap reports the progress", async () => {
    const env = fresh();
    let during: { importing: boolean; imported: number; firstSyncedAt: number | null } | null = null;
    const ended = terminal(env, () => {
      const a = env.ctx.db.get<{ id: string }>("SELECT id FROM accounts WHERE provider = 'archive'")!;
      // Ask bootstrap while the job is between batches.
      void env.api("/api/bootstrap").then(async (r) => {
        during = (await r.json()).accounts.find((x: { id: string }) => x.id === a.id);
      });
    });
    const res = await startImport(env, 600);
    const { accountId } = (await res.json()) as { accountId: string };
    const end = await ended;
    assert.equal(end.type === "import" && end.status, "done");
    for (let i = 0; i < 100 && during === null; i++) await new Promise((r) => setTimeout(r, 10));
    const seen = during as { importing: boolean; imported: number; firstSyncedAt: number | null } | null;
    assert.ok(seen, "bootstrap answered while importing");
    assert.deepEqual([seen.importing, seen.firstSyncedAt], [true, null]);
    assert.ok(seen.imported > 0);

    const stamped = firstSynced(env, accountId)!.first_synced_at;
    assert.equal(typeof stamped, "number");
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE account_id = ? AND created_at > ?", accountId, stamped!)!.n, 0, "every imported message predates it");
    const boot = (await (await env.api("/api/bootstrap")).json()).accounts.find((x: { id: string }) => x.id === accountId);
    assert.deepEqual([boot.importing, boot.imported, boot.firstSyncedAt], [false, 0, stamped]);
  });

  test("two imports into one account run side by side: it fills until the last ends and is stamped once", async () => {
    const env = fresh();
    const ends = new Map<string, ServerEvent>();
    let whenFirstEnded: { importing: boolean; imported: number; stamped: number | null } | null = null;
    const bothEnded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the imports never finished")), 10_000);
      env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => {
        if (e.type !== "import" || e.status === "running") return;
        ends.set(e.jobId, e);
        // Inside the event, so the other job can't have moved on: this is exactly what a client reloading now would see.
        if (ends.size === 1) whenFirstEnded = { ...importStatus(env.ctx.imports, e.accountId), stamped: firstSynced(env, e.accountId)?.first_synced_at ?? null };
        if (ends.size === 2) (clearTimeout(timer), resolve());
      });
    });
    // The long one starts first, so the short one ends while it is still reading.
    const long = (await (await startImport(env, 3000)).json()) as { jobId: string; accountId: string };
    const short = (await (await startImport(env, 300)).json()) as { jobId: string; accountId: string };
    assert.notEqual(long.jobId, short.jobId);
    assert.equal(long.accountId, short.accountId, "both land in the same archive account");
    await bothEnded;

    assert.equal([...ends.keys()][0], short.jobId, "the short one ended first");
    const first = whenFirstEnded as { importing: boolean; imported: number; stamped: number | null } | null;
    assert.ok(first, "the first end was seen");
    assert.equal(first.importing, true, "the account is still filling from the long one");
    assert.equal(first.stamped, null, "and is not 'first synced' yet");
    assert.deepEqual([...ends.values()].map((e) => e.type === "import" && e.status), ["done", "done"]);
    assert.equal(env.ctx.imports.size, 0);
    assert.equal(typeof firstSynced(env, long.accountId)!.first_synced_at, "number");
    const boot = (await (await env.api("/api/bootstrap")).json()).accounts.find((x: { id: string }) => x.id === long.accountId);
    assert.deepEqual([boot.importing, boot.imported], [false, 0]);
  });
});

describe("OAuth redirects say which provider they are about", () => {
  const withKeys = () => fresh({ google: { clientId: "g-client", clientSecret: "g-secret" }, microsoft: { clientId: "m-client", tenant: "common" } });
  const go = async (env: TestEnv, path: string) => {
    const res = await env.api(path);
    assert.equal(res.status, 302, path);
    return new URL(res.headers.get("location")!, "http://127.0.0.1:4399");
  };
  const stateFor = (env: TestEnv, provider: string) => {
    const state = `state-${provider}-${Math.random().toString(36).slice(2)}`;
    env.ctx.db.run("INSERT INTO oauth_states (state, user_id, provider, verifier, expires_at) VALUES (?,?,?,?,?)", state, LOCAL_USER_ID, provider, "verifier", Date.now() + 60_000);
    return state;
  };

  for (const provider of ["google", "microsoft"] as const) {
    test(`${provider}: not configured, expired, denied and a failed exchange all name it`, async () => {
      const bare = fresh({ google: {}, microsoft: { tenant: "common" } });
      let u = await go(bare, `/api/oauth/${provider}/start`);
      assert.deepEqual([u.pathname, u.searchParams.get("error"), u.searchParams.get("provider")], ["/settings/accounts", `${provider}-not-configured`, provider]);

      const env = withKeys();
      u = await go(env, `/api/oauth/${provider}/callback?state=nope&code=c`);
      assert.deepEqual([u.searchParams.get("error"), u.searchParams.get("provider")], ["expired", provider]);

      // A state that was started for the other provider is expired as far as this callback is concerned.
      u = await go(env, `/api/oauth/${provider}/callback?state=${stateFor(env, provider === "google" ? "microsoft" : "google")}&code=c`);
      assert.deepEqual([u.searchParams.get("error"), u.searchParams.get("provider")], ["expired", provider]);

      u = await go(env, `/api/oauth/${provider}/callback?state=${stateFor(env, provider)}&error=access_denied`);
      assert.deepEqual([u.searchParams.get("error"), u.searchParams.get("provider")], ["access_denied", provider]);
      u = await go(env, `/api/oauth/${provider}/callback?state=${stateFor(env, provider)}`);
      assert.deepEqual([u.searchParams.get("error"), u.searchParams.get("provider")], ["denied", provider]);

      const stub = new FetchStub().on("POST", /\/token$/, json({ error: "invalid_grant" }, 400));
      try {
        u = await go(env, `/api/oauth/${provider}/callback?state=${stateFor(env, provider)}&code=bad`);
      } finally {
        stub.restore();
      }
      assert.equal(u.pathname, "/settings/accounts");
      assert.ok(u.searchParams.get("error"));
      assert.equal(u.searchParams.get("provider"), provider);
    });
  }

  test("a successful sign-in names the provider too", async () => {
    const env = withKeys();
    env.ctx.sync.provider = () => ({ kind: "gmail", sync: async () => ({ messages: [], cursor: "1", done: true }) }) as unknown as MailProvider;
    const stub = new FetchStub()
      .on("POST", "https://oauth2.googleapis.com/token", { access_token: "at", refresh_token: "rt", expires_in: 3599 })
      .on("GET", "https://openidconnect.googleapis.com/v1/userinfo", { email: "jordan@fernpoint.co", name: "Jordan" });
    try {
      const u = await go(env, `/api/oauth/google/callback?state=${stateFor(env, "google")}&code=good`);
      assert.deepEqual([u.searchParams.get("connected"), u.searchParams.get("provider")], ["google", "google"]);
    } finally {
      stub.restore();
    }
    for (let i = 0; i < 100 && env.ctx.db.get<{ s: string }>("SELECT sync_status AS s FROM accounts WHERE email = 'jordan@fernpoint.co'")?.s === "syncing"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });
});
