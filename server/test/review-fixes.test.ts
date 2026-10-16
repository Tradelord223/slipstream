import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { assistantEnabled } from "../src/agents/assistant.ts";
import type { Engine, EngineStatus, RunIO } from "../src/agents/engines/types.ts";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import type { Actor } from "../src/commands/registry.ts";
import { migrations } from "../src/db/schema.ts";
import { createRule, runRules } from "../src/mail/labels.ts";
import { compile } from "../src/mail/query.ts";
import { backfillSignals } from "../src/mail/signal-jobs.ts";
import type { Signal } from "../src/mail/signals.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { shapeRow, type ThreadListRow } from "../src/mail/views.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";

/** Server-side fixes from the review: the signals a thread keeps, the one-time code oracle, and the assistant switch. */

const bank = { name: "Quarrystone Bank", email: "no-reply@quarrystonebank.test" };
const alerts = { name: "Tallyho Cloud Alerts", email: "alerts@tallyho.test" };
const ana = { name: "Ana", email: "ana@acme.test" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

function fixture(env: TestEnv) {
  const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID))!;
  const ingest = (...messages: ReturnType<typeof msg>[]) => env.ctx.store.ingest(account, { messages, cursor: null, done: true });
  const tid = (remote: string) => env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = ?", remote)!.id;
  const agent = (name: string, scopes: string[], policy: object = {}): Actor => ({
    kind: "agent",
    user: env.ctx.users.get(LOCAL_USER_ID)!,
    agent: env.ctx.agents.create(LOCAL_USER_ID, name, scopes as never, policy as never).agent,
  });
  const exec = async (actor: Actor, command: string, input: unknown) => {
    const r = await env.ctx.commands.execute(actor, command, input);
    assert.equal(r.status, "done", JSON.stringify(r));
    return (r as unknown as { result: any }).result;
  };
  return { account, ingest, tid, agent, exec };
}

describe("a conversation keeps every signal of its latest message", () => {
  let env: TestEnv;
  let f: ReturnType<typeof fixture>;
  const now = Date.now();
  const search = async (q: string) => ((await (await env.api(`/api/threads?view=search&q=${encodeURIComponent(q)}`)).json()) as { threads: any[] }).threads;
  before(() => {
    env = makeEnv();
    f = fixture(env);
    f.ingest(
      msg({ from: bank, remoteThreadId: "code1", subject: "Your Quarrystone sign-in code", bodyText: "Your verification code is 618204. It expires in 10 minutes.", sentAt: now - 60_000 }),
      msg({ from: alerts, remoteThreadId: "alert1", subject: "New sign-in to your account", bodyText: "We noticed a new sign-in to your account. Your verification code is 482913.", sentAt: now - 30_000 }),
      msg({ from: ana, remoteThreadId: "plain1", subject: "Coffee?", bodyText: "Tuesday morning? I'm at 618 Elm Street.", sentAt: now - 120_000 }),
    );
  });
  after(() => env.cleanup());

  test("a sign-in alert with a code shows under both is:security and is:code", async () => {
    assert.deepEqual((await search("is:security")).map((t) => t.subject), ["New sign-in to your account"]);
    assert.deepEqual((await search("is:code")).map((t) => t.subject).sort(), ["New sign-in to your account", "Your Quarrystone sign-in code"]);
    assert.deepEqual((await search("is:signin is:code")).map((t) => t.subject), ["New sign-in to your account"]);
    assert.deepEqual((await search("-is:security is:code")).map((t) => t.subject), ["Your Quarrystone sign-in code"]);
    const row = (await search("is:security"))[0];
    assert.equal(row.signal, "code", "the first kind leads");
    assert.deepEqual(row.signalDetail, { kind: "code" });
    assert.deepEqual(
      (row.signals as Signal[]).map((s) => s.kind),
      ["code", "security"],
    );
    assert.equal(row.signals[1].service, "Tallyho Cloud");
    assert.ok(!JSON.stringify([row.signal, row.signalDetail, row.signals]).includes("482913"), "the code is in no signal");
    const stored = JSON.parse(env.ctx.db.get<{ signal: string }>("SELECT signal FROM threads WHERE remote_id = 'alert1'")!.signal);
    assert.ok(Array.isArray(stored));
    const plain = (await search("from:ana"))[0];
    assert.equal(plain.signal, null);
    assert.deepEqual(plain.signals, []);
  });

  test("a row from before the list shape reads as a list of one", () => {
    const row = env.ctx.db.get<ThreadListRow>(
      "SELECT t.*, NULL AS labels FROM threads t WHERE t.remote_id = 'code1'",
    )!;
    const shaped = shapeRow({ ...row, signal: '{"kind":"code"}' });
    assert.deepEqual(shaped.signals, [{ kind: "code" }]);
    assert.equal(shaped.signal, "code");
  });

  test("a date from the future can't keep a chip fresh", () => {
    const sentAt = Date.now() + 3 * DAY;
    f.ingest(msg({ from: bank, remoteThreadId: "future1", subject: "Your verification code", bodyText: "Your verification code is 335577.", sentAt }));
    const at = env.ctx.db.get<{ signal_at: number }>("SELECT signal_at FROM threads WHERE remote_id = 'future1'")!.signal_at;
    assert.ok(at <= Date.now(), "the time is when it arrived, not when it claims to be sent");
    const past = env.ctx.db.get<{ signal_at: number; sent: number }>("SELECT t.signal_at, m.sent_at AS sent FROM threads t JOIN messages m ON m.thread_id = t.id WHERE t.remote_id = 'code1'")!;
    assert.equal(past.signal_at, past.sent, "mail that arrives promptly keeps the time it was sent");
  });

  test("the backfill tells open dashboards about the conversations it changed, in batches", async () => {
    env.ctx.db.run("UPDATE messages SET signals = NULL");
    env.ctx.db.run("UPDATE threads SET signal = NULL, signal_at = NULL");
    const events: string[][] = [];
    const off = env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => {
      if (e.type === "threads") events.push(e.threadIds);
    });
    try {
      assert.equal(await backfillSignals(env.ctx, { batch: 2 }), 4);
    } finally {
      off();
    }
    const told = new Set(events.flat());
    assert.deepEqual([...told].sort(), [f.tid("code1"), f.tid("alert1"), f.tid("future1")].sort());
    assert.ok(events.length >= 2, "one event per batch, not one at the end");
    assert.ok(!told.has(f.tid("plain1")), "a conversation with nothing to show isn't announced");
    assert.equal(await backfillSignals(env.ctx), 0);
  });
});

describe("migration 16 converts the signal column to a list", () => {
  test("object rows become lists of one, everything else is kept", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    for (const sql of migrations.slice(0, 15)) db.exec(sql);
    db.exec(`
      INSERT INTO accounts (id, user_id, provider, email, created_at, last_synced_at) VALUES ('a1', 'u', 'imap', 'a@x.test', 1, 500), ('a2', 'u', 'imap', 'b@x.test', 1, NULL);
      INSERT INTO threads (id, account_id, remote_id, updated_at, signal, signal_at) VALUES
        ('t1', 'a1', 'r1', 1, '{"kind":"code"}', 10),
        ('t2', 'a1', 'r2', 1, '{"kind":"delivery","status":"shipped","tracking":"TWP1"}', 20),
        ('t3', 'a1', 'r3', 1, NULL, NULL);
    `);
    db.exec(migrations[15]!);
    const signals = Object.fromEntries((db.prepare("SELECT id, signal FROM threads").all() as { id: string; signal: string | null }[]).map((r) => [r.id, r.signal && JSON.parse(r.signal)]));
    assert.deepEqual(signals, { t1: [{ kind: "code" }], t2: [{ kind: "delivery", status: "shipped", tracking: "TWP1" }], t3: null });
    // The legacy rows are found by the same operators, and read back by the same shaping, as new ones.
    const is = (q: string) => (db.prepare(`SELECT t.id FROM threads t WHERE ${compile(q).where} ORDER BY t.id`).all() as { id: string }[]).map((r) => r.id);
    assert.deepEqual(is("is:code"), ["t1"]);
    assert.deepEqual(is("is:delivery"), ["t2"]);
    assert.deepEqual(is("-is:code"), ["t2", "t3"]);
    assert.deepEqual(JSON.parse(JSON.stringify(db.prepare("SELECT id, first_synced_at FROM accounts ORDER BY id").all())), [
      { id: "a1", first_synced_at: 500 },
      { id: "a2", first_synced_at: null },
    ]);
    assert.deepEqual((db.prepare("SELECT by_agent FROM label_rules").all() as unknown[]).length, 0);
    db.close();
  });
});

describe("an agent can't read a masked code back through search", () => {
  let env: TestEnv;
  let f: ReturnType<typeof fixture>;
  let reader: Actor;
  const now = Date.now();
  const person = async (q: string) => ((await (await env.api(`/api/threads?view=search&q=${encodeURIComponent(q)}`)).json()) as { threads: { subject: string }[] }).threads.map((t) => t.subject);
  const asAgent = async (q: string, extra: object = {}) => f.exec(reader, "mail.search", { query: q, detail: "full", ...extra });
  const subjects = async (q: string) => ((await asAgent(q)) as { threads: { subject: string }[] }).threads.map((t) => t.subject);

  before(() => {
    env = makeEnv();
    f = fixture(env);
    f.ingest(
      msg({ from: bank, remoteThreadId: "code1", subject: "Your Quarrystone sign-in code", bodyText: "Your verification code is 618204. It expires in 10 minutes.", sentAt: now - 60_000 }),
      msg({ from: alerts, remoteThreadId: "alert1", subject: "New sign-in to your account", bodyText: "We noticed a new sign-in to your account. Your verification code is 482913.", sentAt: now - 30_000 }),
      msg({ from: ana, remoteThreadId: "plain1", subject: "Coffee?", bodyText: "Tuesday morning? I'm at 618 Elm Street.", sentAt: now - 120_000 }),
    );
    reader = f.agent("Reader", ["read", "settings", "triage"], { settings: "allow" });
  });
  after(() => env.cleanup());

  test("the digit walk fails: guesses right and wrong give the same answer", async () => {
    for (const [right, wrong] of [["is:code 618", "is:code 619"], ["is:code 618204", "is:code 618205"], ["is:code subject:sign-in", "is:code subject:sign-up"]] as const) {
      const hit = JSON.stringify(await asAgent(right));
      const miss = JSON.stringify(await asAgent(wrong));
      assert.equal(hit.replace(/618|sign-in/g, "x"), miss.replace(/619|sign-up/g, "x"), `${right} / ${wrong}`);
    }
    assert.deepEqual(await subjects("is:code 618"), []);
    assert.deepEqual(await subjects("is:code 619"), []);
    assert.deepEqual(await subjects("is:code subject:code"), [], "subject: matches message text too");
    assert.deepEqual(await subjects("is:code filename:report"), []);
    assert.deepEqual(await subjects("is:code -619"), [], "a negated word answers the same question");
    assert.deepEqual(await subjects("is:code OR 619"), [], "a word in an OR group counts as text");
    assert.deepEqual(await subjects("is:security 618"), []);
  });

  test("other conversations are still searchable, and agents can still list code threads with plain operators", async () => {
    assert.deepEqual(await subjects("elm"), ["Coffee?"]);
    assert.deepEqual(await subjects("618"), ["Coffee?"], "only the conversation without a code answers");
    assert.deepEqual((await subjects("is:code")).sort(), ["New sign-in to your account", "Your Quarrystone sign-in code"]);
    assert.deepEqual(await subjects("is:code from:quarrystonebank"), ["Your Quarrystone sign-in code"]);
    assert.deepEqual(await subjects("is:security newer:7d"), ["New sign-in to your account"]);
    const listed = JSON.stringify(await asAgent("is:code"));
    assert.ok(!listed.includes("618204") && !listed.includes("482913"));
    assert.match(listed, /••••••/);
  });

  test("a person's own search is unchanged", async () => {
    assert.deepEqual(await person("is:code 618"), ["Your Quarrystone sign-in code"]);
    assert.deepEqual(await person("is:code 619"), []);
    assert.deepEqual(await person("is:code subject:sign-in"), ["New sign-in to your account", "Your Quarrystone sign-in code"]);
  });

  test("splits and counts an agent can see don't answer either", async () => {
    const ids: string[] = [];
    for (const query of ["618204", "619204", "subject:code"]) ids.push((await f.exec(reader, "splits.create", { name: `guess ${query}`, query })).id);
    const total = (c: { splits: { id: string; total: number }[] }, id: string) => c.splits.find((x) => x.id === id)!.total;
    const counts = await f.exec(reader, "mail.counts", {});
    for (const id of ids) assert.equal(total(counts, id), 0, "an agent's count never includes a conversation with a code");
    const digest = await f.exec(reader, "mail.digest", {});
    for (const s of digest.splits.filter((x: { id: string }) => ids.includes(x.id))) assert.deepEqual([s.total, s.newest], [0, []]);
    const list = await f.exec(reader, "mail.list", { view: "split", split: ids[0] });
    assert.deepEqual(list.threads, []);
    // The same splits count for the person.
    const mine = (await (await env.api("/api/counts")).json()) as { splits: Record<string, { total: number }> };
    assert.equal(mine.splits[ids[0]!]!.total, 1);
    assert.equal(mine.splits[ids[1]!]!.total, 0);
    // A built-in split that subtracts a custom one doesn't change for a conversation with a code either.
    const builtin = env.ctx.db.get<{ id: string }>("SELECT id FROM splits WHERE builtin = 1 ORDER BY position LIMIT 1");
    if (builtin) assert.equal(total(await f.exec(reader, "mail.counts", {}), builtin.id), total(counts, builtin.id));
    for (const id of ids) await f.exec(reader, "splits.delete", { splitId: id });
  });

  test("auto-label rules an agent wrote skip conversations with a code; a person's rules don't", async () => {
    const made = await f.exec(reader, "labelRules.create", { label: "guess", query: "618", applyToExisting: true });
    assert.equal(made.labelled, 1, "the conversation without a code");
    const other = await f.exec(reader, "labelRules.create", { label: "guess2", query: "619204", applyToExisting: true });
    assert.equal(other.labelled, 0);
    const code618 = await f.exec(reader, "labelRules.create", { label: "guess3", query: "618204", applyToExisting: true });
    assert.equal(code618.labelled, 0, "the right guess and the wrong one look the same");
    env.ctx.db.run("UPDATE label_rules SET last_checked_at = 0");
    runRules(env.ctx);
    const labelled = (label: string) => env.ctx.db.all<{ subject: string }>("SELECT t.subject FROM threads t JOIN thread_labels tl ON tl.thread_id = t.id JOIN labels l ON l.id = tl.label_id WHERE l.name = ?", label).map((r) => r.subject);
    assert.deepEqual(labelled("guess3"), []);
    assert.deepEqual(labelled("guess"), ["Coffee?"]);
    // The person's own rule can still label mail by what it says.
    createRule(env.ctx, LOCAL_USER_ID, "bank codes", "618204");
    env.ctx.db.run("UPDATE label_rules SET last_checked_at = 0");
    runRules(env.ctx);
    assert.deepEqual(labelled("bank codes"), ["Your Quarrystone sign-in code"]);
    // An agent that rewrites that rule takes it over.
    const rule = env.ctx.db.get<{ id: string }>("SELECT id FROM label_rules WHERE label = 'bank codes'")!;
    await f.exec(reader, "labelRules.update", { id: rule.id, query: "482913" });
    assert.equal(env.ctx.db.get<{ by_agent: number }>("SELECT by_agent FROM label_rules WHERE id = ?", rule.id)!.by_agent, 1);
  });
});

describe("a rule an agent proposes is still the agent's once the person approves it", () => {
  let env: TestEnv;
  let f: ReturnType<typeof fixture>;
  before(() => {
    env = makeEnv();
    f = fixture(env);
    f.ingest(
      msg({ from: bank, remoteThreadId: "code1", subject: "Your Quarrystone sign-in code", bodyText: "Your verification code is 618204. It expires in 10 minutes.", sentAt: Date.now() - 60_000 }),
      msg({ from: ana, remoteThreadId: "plain1", subject: "Coffee?", bodyText: "Tuesday morning? I'm at 618 Elm Street.", sentAt: Date.now() - 120_000 }),
    );
  });
  after(() => env.cleanup());

  test("approved rules keep the agent's mark and skip conversations with a code", async () => {
    const bot = f.agent("Proposer", ["read", "settings"]); // the default policy: settings changes wait for approval
    const asked = await env.ctx.commands.execute(bot, "labelRules.create", { label: "guess", query: "618204", applyToExisting: true });
    assert.equal(asked.status, "pending_approval");
    const approved = await env.ctx.commands.approve(LOCAL_USER_ID, (asked as { approvalId: string }).approvalId);
    assert.equal(approved.status, "done");
    const rule = env.ctx.db.get<{ id: string; by_agent: number }>("SELECT id, by_agent FROM label_rules WHERE label = 'guess'")!;
    assert.equal(rule.by_agent, 1);
    const labelled = () => env.ctx.db.all<{ subject: string }>("SELECT t.subject FROM threads t JOIN thread_labels tl ON tl.thread_id = t.id JOIN labels l ON l.id = tl.label_id WHERE l.name = 'guess'");
    assert.deepEqual(labelled(), [], "the code thread wasn't labelled by the guess");

    // A person's own rule, then an agent's approved rewrite of it.
    const mine = createRule(env.ctx, LOCAL_USER_ID, "mine", "618204");
    assert.equal(env.ctx.db.get<{ by_agent: number }>("SELECT by_agent FROM label_rules WHERE id = ?", mine.id)!.by_agent, 0);
    const rewrite = await env.ctx.commands.execute(bot, "labelRules.update", { id: mine.id, query: "482913" });
    assert.equal(rewrite.status, "pending_approval");
    assert.equal(env.ctx.db.get<{ by_agent: number }>("SELECT by_agent FROM label_rules WHERE id = ?", mine.id)!.by_agent, 0, "nothing changes before approval");
    await env.ctx.commands.approve(LOCAL_USER_ID, (rewrite as { approvalId: string }).approvalId);
    assert.equal(env.ctx.db.get<{ by_agent: number }>("SELECT by_agent FROM label_rules WHERE id = ?", mine.id)!.by_agent, 1);
  });
});

/** An engine that records what it is told. */
function recorder() {
  const messages: string[] = [];
  const status: EngineStatus = { id: "loop:openai", label: "Recorder", kind: "loop", ready: true, detail: "", billing: "api" };
  const engine: Engine = {
    id: "loop:openai",
    label: "Recorder",
    kind: "loop",
    status: async () => status,
    async turn(io: RunIO, message: string) {
      messages.push(message);
      io.say("Done.");
      return { outcome: "done" };
    },
  };
  return { engine, messages };
}

describe("a model never receives a one-time code", () => {
  let env: TestEnv;
  let f: ReturnType<typeof fixture>;
  const rec = recorder();
  before(() => {
    env = makeEnv();
    f = fixture(env);
    f.ingest(
      msg({ from: bank, remoteThreadId: "codeS", subject: "Your verification code is 905117", bodyText: "Use it within 10 minutes. Never share it.", sentAt: Date.now() - 60_000 }),
      msg({ from: bank, remoteThreadId: "codeB", subject: "Sign in", bodyText: "Your verification code is 771203. It expires soon.", sentAt: Date.now() - 50_000 }),
    );
    env.ctx.cloud.engines.set("loop:openai", rec.engine);
  });
  after(() => {
    env.ctx.cloud.close();
    env.cleanup();
  });

  test("summaries and drafts send the conversation with the code masked", async () => {
    await env.api("/api/settings/ai-key", { method: "PUT", json: { apiKey: "sk-ant-test" } });
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).messages[0].content);
      return new Response(
        JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: "Fine." }], usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      for (const remote of ["codeS", "codeB"]) {
        assert.equal((await env.api("/api/ai/summarize", { method: "POST", json: { threadId: f.tid(remote) } })).status, 200);
        assert.equal((await env.api("/api/ai/draft", { method: "POST", json: { threadId: f.tid(remote), instruction: "Reply" } })).status, 200);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(sent.length, 4);
    for (const content of sent) {
      assert.ok(!content.includes("905117") && !content.includes("771203"), content);
      assert.match(content, /••••••/);
    }
  });

  test("an assistant chat is told the subjects of the conversations in view, masked", async () => {
    await env.api("/api/settings", { method: "PUT", json: { assistant: "on" } });
    await env.ctx.cloud.start(LOCAL_USER_ID, "What is this?", null, { threadIds: [f.tid("codeS")] }, "loop:openai");
    for (let i = 0; i < 100 && rec.messages.length === 0; i++) await sleep(10);
    const told = rec.messages.at(-1)!;
    assert.match(told, /What is this\?/);
    assert.ok(!told.includes("905117"), told);
    assert.match(told, /Your verification code is ••••••/);
  });

  test("a mail routine is told the subjects of the mail that matched, masked", async () => {
    const before = rec.messages.length;
    env.ctx.cloud.saveRoutine(LOCAL_USER_ID, { name: "Bank mail", instruction: "Look at these.", trigger: { type: "mail", query: "from:quarrystonebank" }, enabled: true, engine: "loop:openai" });
    await sleep(5);
    f.ingest(msg({ from: bank, remoteThreadId: "codeR", subject: "Your verification code is 660418", bodyText: "Use it soon.", sentAt: Date.now() }));
    await env.ctx.cloud.tick();
    for (let i = 0; i < 100 && rec.messages.length === before; i++) await sleep(10);
    const told = rec.messages.at(-1)!;
    assert.match(told, /Look at these/);
    assert.ok(!told.includes("660418"), told);
    assert.match(told, /Your verification code is ••••••/);
  });

  test("what agents read back in activity lines and reply drafts is masked too", async () => {
    const bot = f.agent("Triager", ["read", "triage", "draft"]);
    const done = await env.ctx.commands.execute(bot, "triage.done", { threadIds: [f.tid("codeS")] });
    assert.equal(done.status, "done");
    const activity = JSON.stringify(await f.exec(bot, "activity.list", {}));
    assert.ok(!activity.includes("905117"), activity);
    assert.ok(activity.includes("Your verification code is ••••••"), activity);
    const draft = await f.exec(bot, "drafts.create", { threadId: f.tid("codeS"), body: "Thanks" });
    assert.ok(!JSON.stringify(draft).includes("905117"));
    assert.match(draft.subject, /••••••/);
  });
});

describe("the assistant switch is enforced by the server", () => {
  let env: TestEnv;
  let f: ReturnType<typeof fixture>;
  const rec = recorder();
  const setAssistant = async (v: "on" | "off") => assert.equal((await env.api("/api/settings", { method: "PUT", json: { assistant: v } })).status, 200);
  const calm = async () => {
    for (let i = 0; i < 200; i++) {
      if (env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM cloud_runs WHERE status IN ('starting','running')")!.n === 0) return;
      await sleep(10);
    }
    throw new Error("runs never settled");
  };
  const runs = (origin: string) => env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM cloud_runs WHERE origin = ?", origin)!.n;

  before(() => {
    env = makeEnv({ anthropicApiKey: undefined, openaiApiKey: undefined, geminiApiKey: undefined, openrouterApiKey: undefined });
    f = fixture(env);
    env.ctx.cloud.engines.set("loop:openai", rec.engine);
  });
  after(() => {
    env.ctx.cloud.close();
    env.cleanup();
  });

  test("without a choice or a model it is off; the choice wins", async () => {
    assert.equal(assistantEnabled(env.ctx, LOCAL_USER_ID), false);
    await setAssistant("on");
    assert.equal(assistantEnabled(env.ctx, LOCAL_USER_ID), true);
    await setAssistant("off");
    assert.equal(assistantEnabled(env.ctx, LOCAL_USER_ID), false);
  });

  test("off: a chat can't start, with a clear 409, and nothing is recorded", async () => {
    await setAssistant("off");
    const r = await env.api("/api/cloud/runs", { method: "POST", json: { instruction: "Hello", engine: "loop:openai" } });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /The assistant is off/);
    assert.equal(runs("assistant"), 0);
    assert.equal(rec.messages.length, 0);
  });

  test("on: the chat starts, and a follow-up is refused once it is turned off", async () => {
    await setAssistant("on");
    const r = await env.api("/api/cloud/runs", { method: "POST", json: { instruction: "Hello", engine: "loop:openai" } });
    assert.equal(r.status, 200);
    const run = (await r.json()) as { id: string };
    await calm();
    assert.equal(rec.messages.length, 1);
    await setAssistant("off");
    const again = await env.api(`/api/cloud/runs/${run.id}/messages`, { method: "POST", json: { text: "And?" } });
    assert.equal(again.status, 409);
    await setAssistant("on");
    assert.equal((await env.api(`/api/cloud/runs/${run.id}/messages`, { method: "POST", json: { text: "And?" } })).status, 200);
    await calm();
  });

  test("Autopilot reads no new mail while off, and picks it up when turned on", async () => {
    await setAssistant("on");
    assert.equal((await env.api("/api/autopilot", { method: "PUT", json: { enabled: true, mode: "suggest" } })).status, 200);
    await sleep(5);
    f.ingest(msg({ from: ana, remoteThreadId: "ap1", subject: "Can you confirm?", bodyText: "Are we still on for Tuesday?", sentAt: Date.now() }));
    await setAssistant("off");
    await env.ctx.autopilot.tickUser(LOCAL_USER_ID);
    await env.ctx.autopilot.tick();
    assert.equal(runs("autopilot"), 0);
    assert.equal(env.ctx.db.get("SELECT 1 AS x FROM settings WHERE key = 'autopilot:error'"), undefined, "no error to show for it");
    assert.equal(env.ctx.db.get("SELECT 1 AS x FROM autopilot_items"), undefined);
    await setAssistant("on");
    await env.ctx.autopilot.tickUser(LOCAL_USER_ID);
    await calm();
    assert.equal(runs("autopilot"), 1);
  });

  test("routines don't start while off, scheduled or triggered by mail, and resume when turned on", async () => {
    await setAssistant("on");
    await env.api("/api/autopilot", { method: "PUT", json: { enabled: false } });
    const mailRoutine = env.ctx.cloud.saveRoutine(LOCAL_USER_ID, { name: "Ana mail", instruction: "Look at Ana.", trigger: { type: "mail", query: "from:@acme.test" }, enabled: true, engine: "loop:openai" });
    const scheduled = env.ctx.cloud.saveRoutine(LOCAL_USER_ID, { name: "Morning", instruction: "Morning round.", trigger: { type: "schedule", days: [0, 1, 2, 3, 4, 5, 6], time: "08:00", timezone: "UTC" }, enabled: true, engine: "loop:openai" });
    env.ctx.db.run("UPDATE cloud_routines SET next_run_at = ? WHERE id = ?", Date.now() - 1000, scheduled.id);
    await sleep(5);
    f.ingest(msg({ from: ana, remoteThreadId: "rt1", subject: "Routine bait", bodyText: "Hello", sentAt: Date.now() }));
    const before = rec.messages.length;

    await setAssistant("off");
    await env.ctx.cloud.tick();
    await calm();
    assert.equal(rec.messages.length, before, "nothing started");
    const manual = await env.api(`/api/cloud/routines/${mailRoutine.id}/run`, { method: "POST" });
    assert.equal(manual.status, 409, "a person pressing Run is told why");

    await setAssistant("on");
    await env.ctx.cloud.tick();
    await calm();
    const started = rec.messages.slice(before);
    assert.equal(started.length, 2, "both routines run once it is on");
    assert.ok(started.some((m) => /Look at Ana/.test(m) && /Routine bait/.test(m)));
    assert.ok(started.some((m) => /Morning round/.test(m)));
  });

  test("an agent the person connected themselves works whether it is on or off", async () => {
    await setAssistant("off");
    const bot = f.agent("Bring your own", ["read", "triage"]);
    const listed = await f.exec(bot, "mail.list", {});
    assert.ok(listed.threads.length > 0);
    await f.exec(bot, "triage.markRead", { threadIds: [f.tid("rt1")] });
    // Over the agent API with a token, which is what MCP, the CLI and scripts use.
    const { token } = env.ctx.agents.create(LOCAL_USER_ID, "Over HTTP", ["read"]);
    const res = await env.api("/api/v1/mail.search", { method: "POST", json: { query: "ana" }, headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const mcp = await env.api("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mail_counts", arguments: {} } }),
    });
    assert.equal(mcp.status, 200);
    assert.ok(!(await mcp.text()).includes('"isError":true'));
  });
});
