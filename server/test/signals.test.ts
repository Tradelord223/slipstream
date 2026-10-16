import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { backfillSignals, bundleDeliveries } from "../src/mail/signal-jobs.ts";
import { detectSignals, extractCode, hideCode, maskCodes, topSignal, type Signal } from "../src/mail/signals.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { DEMO_IDENTITY, DemoProvider } from "../src/providers/demo.ts";
import { shareThread } from "../src/team.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";

const detect = (subject: string, text: string, o: { bulk?: boolean; fromName?: string } = {}) =>
  detectSignals({ subject, text, fromEmail: "x@example.test", fromName: o.fromName ?? "", isBulk: o.bulk ?? true, sentAt: 0 });
const kinds = (signals: Signal[]) => signals.map((s) => s.kind);

describe("one-time codes", () => {
  const positives: [string, string, string][] = [
    ["Your verification code is 482913", "Use it within 10 minutes.", "482913"],
    ["Welcome", "Your verification code is 482913. It expires in 10 minutes.", "482913"],
    ["Welcome", "482913 is your verification code.", "482913"],
    ["Sign in", "Use 482 913 as your one-time code to sign in.", "482913"],
    ["Sign in", "Your security code: 4829-1357", "48291357"],
    ["Hi", "Your OTP is 123456. Do not share it.", "123456"],
    ["Hi", "Enter this passcode: 7788", "7788"],
    ["Hi", "Verification code:\n\n  552901\n\nIf you didn't ask for this, ignore it.", "552901"],
    ["Hi", "Your confirmation code is 7K2M9Q", "7K2M9Q"],
    ["Hi", "Two-factor authentication code: 902113", "902113"],
    ["Hi", "Code de vérification : 654321", "654321"],
    ["Hi", "Tu código de verificación es 334455", "334455"],
    ["Hi", "Ihr Bestätigungscode lautet 778899", "778899"],
    ["Hi", "Your code is 2026", "2026"],
    ["Your 551203 login code", "Welcome back.", "551203"],
  ];
  for (const [subject, text, code] of positives)
    test(`finds ${code} in "${(subject + " " + text).replace(/\s+/g, " ").slice(0, 50)}"`, () => {
      assert.equal(extractCode(subject, text), code);
      assert.ok(kinds(detect(subject, text)).includes("code"));
    });

  test("prefers a code in the subject", () => {
    assert.equal(extractCode("Your verification code is 111222", "Your verification code is 333444"), "111222");
  });

  const negatives: [string, string, string][] = [
    ["order number", "Your order #482913 has shipped.", "Order #482913"],
    ["order number near a keyword", "Your order number 482913 is confirmed. Verification code not needed.", ""],
    ["phone number", "Questions? Call 555-482-9137. Security code: none needed.", ""],
    ["split phone digits", "Verification code help line 555 482 9137", ""],
    ["year in a footer", "© 2026 Acme Inc. Never share your verification code with anyone.", ""],
    ["date", "Your verification code expires 2026-10-16", ""],
    ["ZIP code", "Your security code arrives at ZIP 94110-1234", ""],
    ["price", "Verification code required for $1,299 purchases", ""],
    ["price without comma", "Your one-time code covers a charge of $4829", ""],
    ["invoice number", "Invoice 482913. Two-factor authentication is on for your account.", ""],
    ["account number", "Account number 48291357. Enter your passcode on the next screen.", ""],
    ["reference", "Reference: 7788221. Your verification code will arrive by text.", ""],
    ["tracking number", "Tracking number 1Z999AA10123456784. Use your security code at pickup.", ""],
    ["long digits", "Your OTP will be sent to 4155550132", ""],
    ["time", "Your verification code expires at 10:45", ""],
    ["no keyword", "Meeting room 4821 is booked for 10 people", ""],
    ["only a flight confirmation", "Confirmation QK7PZM. Departs 7:40 PM.", ""],
    ["promo code", "Your code is SAVE20 for 20% off at checkout", ""],
    ["a word, not a code", "Your verification code is ready to use", ""],
    ["storage", "Your security code backup uses 16GB of space", ""],
  ];
  for (const [name, text] of negatives)
    test(`ignores ${name}`, () => {
      assert.equal(extractCode("Update", text), null);
      assert.ok(!kinds(detect("Update", text)).includes("code"));
    });

  test("hides the code in every form it was written", () => {
    assert.equal(hideCode("Your code is 482 913 and again 482913.", "482913"), "Your code is •••••• and again ••••••.");
    assert.equal(hideCode("<b>482&nbsp;913</b>", "482913"), "<b>••••••</b>");
    assert.equal(hideCode("Order 1482913 stays", "482913"), "Order 1482913 stays");
    const masked = maskCodes({ subject: "Code 482913", snippet: "Your verification code is 482913.", text: "Your verification code is 482913.", html: "<p>Your verification code is 482913.</p>" });
    assert.ok(!JSON.stringify(masked).includes("482913"));
    const plain = { subject: "Hello", snippet: "Hi", text: "Hi", html: null };
    assert.equal(maskCodes(plain), plain);
  });
});

describe("delivery updates", () => {
  test("shipped, with a labelled tracking number and a named carrier", () => {
    const [s] = detect("Your order has shipped", "Good news. Shipped via Tidewell Parcel.\nTracking number: TWP4471903382\nEstimated delivery Friday.");
    assert.deepEqual(s, { kind: "delivery", status: "shipped", tracking: "TWP4471903382", carrier: "Tidewell Parcel" });
  });
  test("a table cell layout still yields the tracking number", () => {
    const [s] = detect("Your order has shipped", "Order SM-4471 is on its way\nShipping $9.00\nCarrier Tidewell Parcel\nTracking number TWP4471903382\nTotal $161.00");
    assert.deepEqual(s, { kind: "delivery", status: "shipped", tracking: "TWP4471903382", carrier: "Tidewell Parcel" });
  });
  test("order numbers are not tracking numbers", () => {
    const [s] = detect("Your order has shipped", "Order #SM-4471 is on its way. Invoice TC-20931.");
    assert.deepEqual(s, { kind: "delivery", status: "shipped" });
  });
  const statuses: [string, string, string][] = [
    ["Out for delivery today", "Your package is out for delivery.", "out_for_delivery"],
    ["Delivered: your order", "Your package was delivered to the front porch.", "delivered"],
    ["Your parcel is in transit", "It left the sorting center.", "in_transit"],
    ["Arriving tomorrow", "Your order is arriving tomorrow by 8 PM.", "in_transit"],
    ["Shipment delayed", "Your shipment is delayed by weather.", "delayed"],
    ["Your order is held at customs", "Customs clearance can take 2 days.", "customs"],
    ["Shipped: your order", "Thanks!", "shipped"],
    ["Your order is on its way", "Thanks for shopping.", "shipped"],
  ];
  for (const [subject, text, status] of statuses)
    test(`reads "${subject}" as ${status}`, () => {
      const s = detect(subject, text)[0] as Extract<Signal, { kind: "delivery" }>;
      assert.equal(s?.kind, "delivery");
      assert.equal(s?.status, status);
    });
  test("UPS-style tracking numbers are found without a label", () => {
    const [s] = detect("Your order has shipped", "It is on its way. 1Z999AA10123456784 is the number to use with UPS.");
    assert.deepEqual(s, { kind: "delivery", status: "shipped", tracking: "1Z999AA10123456784", carrier: "UPS" });
  });
  test("a named carrier is reported only when the mail names one", () => {
    const [s] = detect("Your order has shipped", "Your order has shipped. Tracking number: ABC1234567");
    assert.equal((s as { carrier?: string }).carrier, undefined);
  });
  const quiet: [string, string][] = [
    ["Trip confirmed", "Flight PA 2817. Arrives Lisbon 7:05 AM. Confirmation QK7PZM."],
    ["Sprint review deck", "Looks good, ship it. Otherwise swap the slides."],
    ["Retro notes", "Went well: shipping the lane grouping early. Didn't: three rounds on a badge."],
    ["Spring is on its way", "Our newsletter about gardens."],
    ["Your flight is delayed", "Departure moved to 9 PM."],
    ["Teams ship weekly", "Teams that have shipped weekly argue about scope."],
    ["Thank you for your order", "We'll email you when it has shipped."],
  ];
  for (const [subject, text] of quiet)
    test(`stays quiet on "${subject}"`, () => {
      assert.ok(!kinds(detect(subject, text)).includes("delivery"));
    });
});

describe("sign-in alerts", () => {
  test("new sign-in names the service", () => {
    assert.deepEqual(detect("New sign-in to your account", "We noticed a new sign-in from Chrome on Windows.", { fromName: "Tallyho Cloud Alerts" }), [
      { kind: "security", service: "Tallyho Cloud" },
    ]);
  });
  const phrases = [
    "New login to your account",
    "Someone signed in from a new device",
    "We noticed an unusual sign-in",
    "Was your account accessed from Denver?",
    "New device signed in to your account",
  ];
  for (const p of phrases) test(`matches "${p}"`, () => assert.ok(kinds(detect(p, "Details inside.")).includes("security")));
  test("a service is left out when the sender has no display name", () => {
    assert.deepEqual(detect("New sign-in", "A new sign-in happened.", { fromName: "" }), [{ kind: "security" }]);
  });
  test("ordinary account mail stays quiet", () => {
    for (const [s, t] of [
      ["Welcome", "You're signed in to your new account. Sign in any time."],
      ["New devices on sale", "Shop the new device line, 20% off."],
      ["Your password was reset", "Reset complete."],
    ] as const)
      assert.ok(!kinds(detect(s, t)).includes("security"), s);
  });
});

describe("urgent mail from people", () => {
  const person = (subject: string, text: string) => detect(subject, text, { bulk: false });
  const cases: [string, string, string][] = [
    ["Court date moved", "Your hearing is now March 3.", "Legal notice"],
    ["Hi", "We received a summons yesterday. Call me.", "Legal notice"],
    ["Cease and desist", "Please read the attached.", "Legal notice"],
    ["Notice to vacate", "The landlord posted it today.", "Legal notice"],
    ["Invoice 442 is past due", "Please pay by Friday.", "Overdue payment"],
    ["Hi", "This invoice is overdue by 30 days, balance $240.", "Overdue payment"],
    ["Final notice", "Your balance of $90 goes to collections Friday.", "Overdue payment"],
    ["Final notice", "Please call our office.", "Final notice"],
    ["Chargeback filed", "The customer disputed the charge.", "Payment dispute"],
    ["Lease renewal: deadline tomorrow", "Sign by 5.", "Deadline"],
    ["Hi", "The grant deadline is today at noon.", "Deadline"],
  ];
  for (const [subject, text, reason] of cases)
    test(`"${subject}" is ${reason}`, () => assert.deepEqual(person(subject, text)[0], { kind: "urgent", reason }));

  test("bulk senders never raise it", () => {
    assert.deepEqual(detect("Final notice: sale ends tonight", "Past due prices end today. Deadline tomorrow!", { bulk: true }), []);
    assert.deepEqual(detect("Your invoice is past due", "Balance $90.", { bulk: true }), []);
  });
  test("stays quiet on ordinary personal mail", () => {
    for (const [s, t] of [
      ["Coffee next week?", "Mornings are best."],
      ["Library", "That book is overdue, oops."],
      ["Chargers", "Collections of old photos attached."],
      ["Lunch", "No deadline, whenever works."],
    ] as const)
      assert.deepEqual(person(s, t), [], s);
  });
  test("quoted history doesn't count", () => {
    assert.deepEqual(person("Re: Lunch", "Sounds good!\n\nOn Mon, Ana wrote:\n> This is your final notice, invoice past due."), []);
  });
});

test("topSignal: urgent, then code, then security, then delivery", () => {
  const all: Signal[] = [
    { kind: "delivery", status: "shipped" },
    { kind: "security" },
    { kind: "code" },
    { kind: "urgent", reason: "Deadline" },
  ];
  assert.equal(topSignal(all)?.kind, "urgent");
  assert.equal(topSignal(all.slice(0, 3))?.kind, "code");
  assert.equal(topSignal(all.slice(0, 2))?.kind, "security");
  assert.equal(topSignal(all.slice(0, 1))?.kind, "delivery");
  assert.equal(topSignal([]), null);
});

describe("signals in the store", () => {
  let env: TestEnv;
  let account: AccountRow;
  const bank = { name: "Quarrystone Bank", email: "no-reply@quarrystonebank.test" };
  const shop = { name: "Saltmarrow Ceramics", email: "orders@saltmarrow.test" };
  const ana = { name: "Ana", email: "ana@acme.test" };
  const row = <T,>(sql: string, ...p: (string | number)[]) => env.ctx.db.get<T>(sql, ...p)!;
  const tid = (remote: string) => row<{ id: string }>("SELECT id FROM threads WHERE remote_id = ?", remote).id;
  const run = async (command: string, input: unknown) => {
    const r = await env.api(`/api/v1/${command}`, { method: "POST", json: input });
    return { status: r.status, body: await r.json() };
  };
  const ingest = (...messages: ReturnType<typeof msg>[]) => env.ctx.store.ingest(account, { messages, cursor: null, done: true });
  const now = Date.now();

  before(() => {
    env = makeEnv();
    account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID))!;
    ingest(
      msg({ from: bank, remoteThreadId: "code1", subject: "Your Quarrystone sign-in code", bodyText: "Your verification code is 618204. It expires in 10 minutes.", sentAt: now - 60_000 }),
      msg({ from: ana, remoteThreadId: "plain1", subject: "Coffee?", bodyText: "Tuesday morning?", sentAt: now - 120_000 }),
    );
  });
  after(() => env.cleanup());

  test("signals are stored per message, and the code value is nowhere in them", () => {
    const m = row<{ signals: string }>("SELECT signals FROM messages WHERE subject = 'Your Quarrystone sign-in code'");
    assert.deepEqual(JSON.parse(m.signals), [{ kind: "code" }]);
    assert.ok(!m.signals.includes("618204"));
    const t = row<{ signal: string; signal_at: number }>("SELECT signal, signal_at FROM threads WHERE remote_id = 'code1'");
    assert.deepEqual(JSON.parse(t.signal), { kind: "code" });
    assert.ok(!t.signal.includes("618204"));
    assert.equal(row<{ signal: string | null }>("SELECT signal FROM threads WHERE remote_id = 'plain1'").signal, null);
    assert.equal(row<{ signals: string }>("SELECT signals FROM messages WHERE subject = 'Coffee?'").signals, "[]");
  });

  test("the thread's signal follows its latest incoming message", () => {
    ingest(
      msg({ from: shop, remoteThreadId: "ship1", subject: "Your order has shipped", bodyText: "Order SM-1 has shipped. Tracking number: TWP1111222233", sentAt: now - 90_000_000 }),
    );
    assert.equal(JSON.parse(row<{ signal: string }>("SELECT signal FROM threads WHERE remote_id = 'ship1'").signal).kind, "delivery");
    // A later plain reply from the same sender changes the top line to nothing; our own reply doesn't count.
    ingest(
      msg({ from: shop, remoteThreadId: "ship1", subject: "Re: Your order has shipped", bodyText: "Thanks for writing, glad it helped.", sentAt: now - 80_000_000 }),
    );
    assert.equal(row<{ signal: string | null }>("SELECT signal FROM threads WHERE remote_id = 'ship1'").signal, null);
    ingest(
      msg({ from: { name: "Me", email: "me@example.test" }, outgoing: true, remoteThreadId: "ship1", subject: "Re: Your order has shipped", bodyText: "Your verification code is 111222", sentAt: now - 70_000_000 }),
    );
    assert.equal(row<{ signal: string | null }>("SELECT signal FROM threads WHERE remote_id = 'ship1'").signal, null);
    assert.equal(row<{ signals: string }>("SELECT signals FROM messages WHERE body_text = 'Your verification code is 111222'").signals, "[]", "outgoing mail gets none");
  });

  test("the signal is kept while a local triage action is pending", () => {
    const id = tid("code1");
    env.ctx.db.run("INSERT INTO pending_actions (account_id, kind, payload, run_after, created_at) VALUES (?,?,?,?,?)", account.id, "triage", JSON.stringify({ threadId: id }), now + 60_000, now);
    env.ctx.db.run("UPDATE threads SET signal = NULL, signal_at = NULL WHERE id = ?", id);
    env.ctx.store.recomputeThread(id);
    assert.equal(JSON.parse(row<{ signal: string }>("SELECT signal FROM threads WHERE id = ?", id).signal).kind, "code");
    env.ctx.db.run("DELETE FROM pending_actions");
  });

  test("search operators", async () => {
    const q = async (query: string) => {
      const r = await env.api(`/api/threads?view=search&q=${encodeURIComponent(query)}`);
      return ((await r.json()) as { threads: { subject: string }[] }).threads.map((t) => t.subject);
    };
    assert.deepEqual(await q("is:code"), ["Your Quarrystone sign-in code"]);
    assert.deepEqual(await q("-is:code from:ana"), ["Coffee?"]);
    assert.deepEqual(await q("is:package"), [], "the shipped thread now ends with a plain reply");
    ingest(msg({ from: shop, remoteThreadId: "ship2", subject: "Package update", bodyText: "Your package is out for delivery. Tracking number: TWP9999888877", sentAt: now - 1000 }));
    assert.deepEqual(await q("is:delivery"), ["Package update"]);
    assert.deepEqual(await q("is:package"), ["Package update"]);
    ingest(msg({ from: { name: "Tallyho Cloud Alerts", email: "alerts@tallyho.test" }, remoteThreadId: "sec1", subject: "New sign-in", bodyText: "We noticed a new sign-in to your account.", sentAt: now - 2000 }));
    assert.deepEqual(await q("is:security"), ["New sign-in"]);
    assert.deepEqual(await q("is:signin"), ["New sign-in"]);
    ingest(msg({ from: ana, remoteThreadId: "urg1", subject: "Lease: deadline tomorrow", bodyText: "Please sign tonight.", sentAt: now - 3000 }));
    assert.deepEqual(await q("is:urgent"), ["Lease: deadline tomorrow"]);
  });

  test("list rows and conversations carry the signal, never the code", async () => {
    const list = (await (await env.api("/api/threads?view=search&q=is:code")).json()) as { threads: { signal: string; signalAt: number; signalDetail: Signal }[] };
    assert.equal(list.threads[0]!.signal, "code");
    assert.deepEqual(list.threads[0]!.signalDetail, { kind: "code" });
    assert.ok(list.threads[0]!.signalAt > 0);
    const detail = (await (await env.api(`/api/threads/${tid("code1")}`)).json()) as { messages: { isBulk: boolean; signals: Signal[] }[] };
    assert.equal(detail.messages[0]!.isBulk, true);
    assert.deepEqual(detail.messages[0]!.signals, [{ kind: "code" }]);
    const signalFields = (t: { signal: unknown; signalAt: unknown; signalDetail: unknown }) => JSON.stringify([t.signal, t.signalAt, t.signalDetail]);
    assert.ok(!signalFields(list.threads[0]!).includes("618204"));
    assert.ok(!JSON.stringify(detail.messages[0]!.signals).includes("618204"));
    const plain = (await (await env.api(`/api/threads/${tid("plain1")}`)).json()) as { thread: { signal: null }; messages: { signals: Signal[] }[] };
    assert.equal(plain.thread.signal, null);
    assert.deepEqual(plain.messages[0]!.signals, []);
  });

  test("GET /api/messages/:id/code answers a person, and only for their own messages", async () => {
    const id = row<{ id: string }>("SELECT id FROM messages WHERE subject = 'Your Quarrystone sign-in code'").id;
    const ok = await env.api(`/api/messages/${id}/code`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ok.json(), { code: "618204" });
    const noCode = row<{ id: string }>("SELECT id FROM messages WHERE subject = 'Coffee?'").id;
    assert.equal((await env.api(`/api/messages/${noCode}/code`)).status, 404);
    assert.equal((await env.api("/api/messages/msg_nope/code")).status, 404);

    // Someone else's mailbox.
    env.ctx.db.run("INSERT INTO users (id, email, name, created_at) VALUES ('usr_other','o@o.test','Other',0)");
    const otherAccount = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, "usr_other", "other@example.test"))!;
    env.ctx.store.ingest(otherAccount, {
      messages: [msg({ from: bank, remoteThreadId: "o1", subject: "Code", bodyText: "Your verification code is 998877", to: [{ name: "O", email: "other@example.test" }] })],
      cursor: null,
      done: true,
    });
    const theirs = row<{ id: string }>("SELECT id FROM messages WHERE body_text LIKE '%998877%'").id;
    assert.equal((await env.api(`/api/messages/${theirs}/code`)).status, 404);

    // An agent token can't reach it, and its own tools never return a code.
    const { token } = env.ctx.agents.create(LOCAL_USER_ID, "Reader", ["read"]);
    const viaToken = await env.api(`/api/messages/${id}/code`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(viaToken.status, 403);
    assert.ok(!(await viaToken.text()).includes("618204"));
  });

  test("GET /api/threads/:id/code copies from a list row; agents are refused", async () => {
    const threadId = row<{ thread_id: string }>("SELECT thread_id FROM messages WHERE subject = 'Your Quarrystone sign-in code'").thread_id;
    const ok = await env.api(`/api/threads/${threadId}/code`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ok.json(), { code: "618204" });
    assert.equal((await env.api(`/api/threads/${tid("plain1")}/code`)).status, 404);
    const { token } = env.ctx.agents.create(LOCAL_USER_ID, "Reader", ["read"]);
    assert.equal((await env.api(`/api/threads/${threadId}/code`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  });

  test("agents read mail with codes masked; people still see their own mail", async () => {
    const { agent } = env.ctx.agents.create(LOCAL_USER_ID, "Reader", ["read"]);
    const user = env.ctx.users.get(LOCAL_USER_ID)!;
    const asAgent = { kind: "agent" as const, user, agent };
    const id = tid("code1");
    const results = [
      await env.ctx.commands.execute(asAgent, "mail.read", { threadId: id }),
      await env.ctx.commands.execute(asAgent, "mail.search", { query: "is:code" }),
      await env.ctx.commands.execute(asAgent, "mail.search", { query: "is:code", detail: "full" }),
      await env.ctx.commands.execute(asAgent, "mail.list", { view: "inbox", detail: "full" }),
      await env.ctx.commands.execute(asAgent, "mail.digest", {}),
    ];
    for (const r of results) assert.ok(!JSON.stringify(r).includes("618204"), JSON.stringify(r).slice(0, 200));
    const read = results[0] as { result: { messages: { text: string }[] } };
    assert.match(read.result.messages[0]!.text, /Your verification code is ••••••/);
    const person = (await (await env.api(`/api/threads/${id}`)).json()) as { messages: { text: string }[] };
    assert.match(person.messages[0]!.text, /618204/);
  });

  test("a shared conversation never carries the code", () => {
    // Teams are a server feature; exercising the snapshot builder directly keeps this in local mode.
    env.ctx.users.createWorkspace(LOCAL_USER_ID, "Team");
    const shared = shareThread(env.ctx, LOCAL_USER_ID, tid("code1"));
    const snap = row<{ snapshot: string }>("SELECT snapshot FROM shared_threads WHERE id = ?", shared.id).snapshot;
    assert.ok(!snap.includes("618204"));
    assert.match(snap, /••••••/);
  });
});

describe("settings", () => {
  let env: TestEnv;
  const get = async () => ((await (await env.api("/api/bootstrap")).json()) as { settings: Record<string, unknown> }).settings;
  const put = (json: unknown) => env.api("/api/settings", { method: "PUT", json });
  before(() => {
    env = makeEnv();
  });
  after(() => env.cleanup());

  test("helpers, sender logos and the assistant switch are saved with strict shapes", async () => {
    assert.equal((await put({ assistant: "on", senderLogos: false, helpers: { codes: true, deliveries: "all", securityAlerts: false, urgent: true } })).status, 200);
    const s = await get();
    assert.equal(s.assistant, "on");
    assert.equal(s.senderLogos, false);
    assert.deepEqual(s.helpers, { codes: true, deliveries: "all", securityAlerts: false, urgent: true });
    for (const bad of [{ assistant: "maybe" }, { senderLogos: "yes" }, { helpers: { codes: true } }, { helpers: { codes: true, deliveries: "some", securityAlerts: true, urgent: true } }, { helpers: { codes: true, deliveries: "all", securityAlerts: true, urgent: true, extra: 1 } }])
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  });

  test("the assistant defaults to on once a model is set up, and off until then", async () => {
    // Keys in the environment count as set up, so the test pins them off.
    const fresh = makeEnv({ anthropicApiKey: undefined, openaiApiKey: undefined, geminiApiKey: undefined, openrouterApiKey: undefined });
    try {
      const read = async () => ((await (await fresh.api("/api/bootstrap")).json()) as { settings: { assistant: string } }).settings.assistant;
      assert.equal(await read(), "off");
      fresh.ctx.cloud.accounts.setKey(LOCAL_USER_ID, "openai", "sk-test-key-12345");
      assert.equal(await read(), "on", "a saved key");
      fresh.ctx.cloud.accounts.setKey(LOCAL_USER_ID, "openai", null);
      assert.equal(await read(), "off");
      fresh.ctx.cloud.accounts.setDefaultEngine(LOCAL_USER_ID, "loop:anthropic");
      assert.equal(await read(), "on", "a default engine");
      fresh.ctx.db.run("DELETE FROM settings WHERE key = 'engines'");
      assert.equal(await read(), "off");
      assert.equal((await fresh.api("/api/settings", { method: "PUT", json: { assistant: "off" } })).status, 200);
      fresh.ctx.cloud.accounts.setKey(LOCAL_USER_ID, "openai", "sk-test-key-12345");
      assert.equal(await read(), "off", "an explicit choice wins");
    } finally {
      fresh.cleanup();
    }
  });
});

describe("the demo mailbox", () => {
  let env: TestEnv;
  before(() => {
    env = makeEnv();
  });
  after(() => env.cleanup());

  test("exactly the planted threads show a signal", async () => {
    const accountId = addAccount(env.ctx, LOCAL_USER_ID, DEMO_IDENTITY.email);
    const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId)!;
    const page = await new DemoProvider({ accountId, email: DEMO_IDENTITY.email, auth: null, saveAuth() {}, initialSyncDays: 30 }).sync(null);
    env.ctx.store.ingest(account, page);
    const found = Object.fromEntries(
      env.ctx.db.all<{ remote_id: string; signal: string }>("SELECT remote_id, signal FROM threads WHERE signal IS NOT NULL").map((r) => [r.remote_id, JSON.parse(r.signal) as Signal]),
    );
    assert.deepEqual(found, {
      "bank-code": { kind: "code" },
      "alert-signin": { kind: "security", service: "Tallyho Cloud" },
      "lease-deadline": { kind: "urgent", reason: "Deadline" },
      "saltmarrow-ship": { kind: "delivery", status: "shipped", tracking: "TWP4471903382", carrier: "Tidewell Parcel" },
      "saltmarrow-out": { kind: "delivery", status: "out_for_delivery", tracking: "TWP4471903382", carrier: "Tidewell Parcel" },
    });
    const code = env.ctx.db.get<{ sent_at: number }>("SELECT m.sent_at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.remote_id = 'bank-code'")!;
    assert.ok(Date.now() - code.sent_at < 5 * 60_000, "the code arrived a couple of minutes ago");
    // The two updates for one package: the shipped notice steps aside for "out for delivery".
    assert.equal(bundleDeliveries(env.ctx, Date.now() + 1), 1);
    const inbox = (remote: string) => env.ctx.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE remote_id = ?", remote)!.in_inbox;
    assert.deepEqual([inbox("saltmarrow-ship"), inbox("saltmarrow-out")], [0, 1]);
  });

  test("rows name a logo domain for company senders only", async () => {
    const list = (await (await env.api("/api/threads?view=search&q=in:all&limit=500")).json()) as { threads: { category: string; logoDomain: string | null }[] };
    assert.ok(list.threads.some((t) => t.logoDomain === "quarrystonebank.com"));
    for (const t of list.threads) if (t.category === "important") assert.equal(t.logoDomain, null);
  });
});

describe("delivery bundling", () => {
  let env: TestEnv;
  let account: AccountRow;
  const shop = { name: "Saltmarrow Ceramics", email: "orders@saltmarrow.test" };
  const row = <T,>(sql: string, ...p: (string | number)[]) => env.ctx.db.get<T>(sql, ...p)!;
  const tid = (remote: string) => row<{ id: string }>("SELECT id FROM threads WHERE remote_id = ?", remote).id;
  const inInbox = (remote: string) => Boolean(row<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE remote_id = ?", remote).in_inbox);
  const base = Date.now();
  const update = (thread: string, subject: string, text: string, at: number, from = shop) =>
    msg({ from, remoteThreadId: thread, subject, bodyText: text, sentAt: base - at });
  // A pass looks at mail stored before its clock reading, so each pass sits one millisecond ahead and the next ingest waits it out.
  let lastPass = 0;
  const tick = () => {
    lastPass = Date.now() + 1;
    return bundleDeliveries(env.ctx, lastPass);
  };
  const ingest = (...messages: ReturnType<typeof msg>[]) => {
    while (Date.now() < lastPass) {
      /* wait for the clock */
    }
    env.ctx.store.ingest(account, { messages, cursor: null, done: true });
  };

  before(() => {
    env = makeEnv();
    account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID))!;
  });
  after(() => env.cleanup());

  test("a newer update moves the older ones for the same package to Done, once, as Slipstream", async () => {
    ingest(
      update("a-old", "Your order has shipped", "Your order has shipped. Tracking number: TWP5550001111", 5000),
      update("a-mid", "In transit", "Your package is in transit. Tracking number: twp5550001111", 4000),
      update("b-other", "Your other order has shipped", "Your order has shipped. Tracking number: TWP7770002222", 4500),
      update("c-starred", "Starred update", "Your order has shipped. Tracking number: TWP5550001111", 4800),
      update("d-replied", "Replied update", "Your order has shipped. Tracking number: TWP5550001111", 4700),
      update("e-security", "New sign-in", "We noticed a new sign-in. Tracking number: TWP5550001111", 4600, { name: "Svc Alerts", email: "alerts@svc.test" }),
    );
    env.ctx.triage.apply(LOCAL_USER_ID, { kind: "star", threadIds: [tid("c-starred")] });
    ingest(msg({ from: { name: "Me", email: "me@example.test" }, outgoing: true, remoteThreadId: "d-replied", subject: "Re: Replied update", bodyText: "Thanks!", sentAt: base - 4600 }));
    assert.equal(row<{ in_sent: number }>("SELECT in_sent FROM threads WHERE remote_id = 'd-replied'").in_sent, 1);
    // Among the first batch, the newest update (a-mid) already supersedes a-old.
    assert.equal(tick(), 1);
    assert.equal(inInbox("a-old"), false);
    ingest(update("a-new", "Out for delivery", "Your package is out for delivery. Tracking number: TWP5550001111", 1000));
    assert.equal(tick(), 1, "then the next update supersedes a-mid, matching the number whatever its case");
    assert.equal(inInbox("a-new"), true);
    assert.equal(inInbox("a-old"), false);
    assert.equal(inInbox("a-mid"), false);
    assert.equal(inInbox("b-other"), true, "a different package is untouched");
    assert.equal(inInbox("c-starred"), true, "starred is untouched");
    assert.equal(inInbox("d-replied"), true, "a conversation you replied in is untouched");
    assert.equal(inInbox("e-security"), true, "sign-in alerts are never moved");

    const acts = env.ctx.commands.activity(LOCAL_USER_ID, { limit: 10 }).filter((a) => a.command === "deliveries.bundle");
    assert.equal(acts.length >= 1, true);
    const last = acts[0]!;
    assert.equal(last.actor.name, "Slipstream");
    assert.equal(last.actor.kind, "human");
    assert.equal(last.canUndo, true);
    assert.equal(tick(), 0, "a second pass has nothing new to do");
  });

  test("undo puts them back and they stay back", async () => {
    ingest(update("f-old", "Shipped", "Your order has shipped. Tracking number: TWP1234567890", 3000));
    tick();
    ingest(update("f-new", "Shipped again", "Your order is out for delivery. Tracking number: TWP1234567890", 2000));
    tick();
    assert.equal(inInbox("f-old"), false);
    const act = env.ctx.commands.activity(LOCAL_USER_ID, { limit: 5 }).find((a) => a.command === "deliveries.bundle" && a.threadIds.includes(tid("f-old")))!;
    assert.ok(act);
    const user = env.ctx.users.get(LOCAL_USER_ID)!;
    await env.ctx.commands.undo({ kind: "human", user }, act.id);
    assert.equal(inInbox("f-old"), true);
    tick();
    assert.equal(inInbox("f-old"), true, "undone updates aren't swept again until something new arrives");
  });

  test("undo still works after the exact window, through the inverse command", async () => {
    ingest(update("g-old", "Shipped", "Your order has shipped. Tracking number: TWP4040404040", 3000));
    tick();
    ingest(update("g-new", "Delivered", "Your package was delivered. Tracking number: TWP4040404040", 2000));
    tick();
    assert.equal(inInbox("g-old"), false);
    const act = env.ctx.commands.activity(LOCAL_USER_ID, { limit: 5 }).find((a) => a.command === "deliveries.bundle" && a.threadIds.includes(tid("g-old")))!;
    env.ctx.db.run("UPDATE activity SET undo_token = NULL WHERE id = ?", act.id);
    await env.ctx.commands.undo({ kind: "human", user: env.ctx.users.get(LOCAL_USER_ID)! }, act.id);
    assert.equal(inInbox("g-old"), true);
  });

  test("history from a newly connected account isn't tidied", () => {
    const sixtyDays = 60 * 86_400_000;
    ingest(
      update("i-old", "Shipped", "Your order has shipped. Tracking number: TWP6060606060", sixtyDays + 3000),
      update("i-new", "Delivered", "Your package was delivered. Tracking number: TWP6060606060", sixtyDays + 2000),
    );
    assert.equal(tick(), 0);
    assert.equal(inInbox("i-old"), true);
  });

  test("helpers.deliveries = all leaves everything alone", () => {
    env.ctx.db.run("INSERT INTO settings (user_id, key, value) VALUES (?, 'helpers', ?)", LOCAL_USER_ID, JSON.stringify({ codes: true, deliveries: "all", securityAlerts: true, urgent: true }));
    ingest(update("h-old", "Shipped", "Your order has shipped. Tracking number: TWP8080808080", 3000));
    tick();
    ingest(update("h-new", "Out for delivery", "Your package is out for delivery. Tracking number: TWP8080808080", 2000));
    assert.equal(tick(), 0);
    assert.equal(inInbox("h-old"), true);
    env.ctx.db.run("DELETE FROM settings WHERE key = 'helpers'");
  });
});

describe("backfill", () => {
  test("scans mail stored before signals existed, in batches, once", async () => {
    const env = makeEnv();
    try {
      const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID))!;
      const bank = { name: "Bank", email: "no-reply@bank.test" };
      env.ctx.store.ingest(account, {
        messages: [
          msg({ from: bank, remoteThreadId: "t1", subject: "Code", bodyText: "Your verification code is 112233" }),
          ...[2, 3, 4, 5, 6].map((i) => msg({ from: { name: "Ana", email: "ana@acme.test" }, remoteThreadId: `t${i}`, subject: `Hello ${i}`, bodyText: "Hi there" })),
        ],
        cursor: null,
        done: true,
      });
      // As if every message predated the feature.
      env.ctx.db.run("UPDATE messages SET signals = NULL");
      env.ctx.db.run("UPDATE threads SET signal = NULL, signal_at = NULL");
      assert.equal(await backfillSignals(env.ctx, { batch: 2 }), 6);
      assert.equal(env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE signals IS NULL")!.n, 0);
      assert.deepEqual(env.ctx.db.all<{ remote_id: string }>("SELECT remote_id FROM threads WHERE signal IS NOT NULL").map((r) => r.remote_id), ["t1"]);
      assert.equal(await backfillSignals(env.ctx), 0, "idempotent");
      // A stop request ends it between batches.
      env.ctx.db.run("UPDATE messages SET signals = NULL");
      const stop = new AbortController();
      stop.abort();
      assert.equal(await backfillSignals(env.ctx, { signal: stop.signal }), 0);
    } finally {
      env.cleanup();
    }
  });
});
