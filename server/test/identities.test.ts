import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import type { Actor } from "../src/commands/registry.ts";
import { createDraft, draftRecipients, sendDraft } from "../src/mail/drafts.ts";
import { unsubscribe } from "../src/mail/unsubscribe.ts";
import { addIdentity, listIdentities, ownAddresses, replyIdentity, resolveFrom, syncProviderIdentities } from "../src/mail/identities.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";
import { FetchStub, json, type Call } from "./stub.ts";

/** Send-as identities: managing them, who a draft may be sent as, and recognising our own mail from an alias. */

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const ME = "sam@fernpoint.test";
const ALIAS = "help@fernpoint.test";
const post = (env: TestEnv, path: string, body: unknown) => env.api(path, { method: "POST", json: body });
const patch = (env: TestEnv, path: string, body: unknown) => env.api(path, { method: "PATCH", json: body });

describe("managing identities", () => {
  let env: TestEnv;
  let acc: string;
  before(() => {
    env = makeEnv();
    acc = addAccount(env.ctx, LOCAL_USER_ID, ME, "imap");
  });
  after(() => env.cleanup());

  test("add, list in the bootstrap, edit and remove an address", async () => {
    const r = await post(env, `/api/accounts/${acc}/identities`, {
      email: "  Help@Fernpoint.test ",
      name: "Fernpoint Help",
      replyTo: "Desk@fernpoint.test",
      signatureHtml: "<p>Thanks,<br>Sam</p><script>alert(1)</script>",
    });
    assert.equal(r.status, 200);
    const made = await r.json();
    assert.deepEqual({ ...made, id: "x" }, { id: "x", email: ALIAS, name: "Fernpoint Help", replyTo: "desk@fernpoint.test", signatureHtml: "<p>Thanks,<br />Sam</p>", source: "manual" });

    const boot = await (await env.api("/api/bootstrap")).json();
    assert.deepEqual(boot.accounts.find((a: { id: string }) => a.id === acc).identities, [made]);

    const edited = await (await patch(env, `/api/accounts/${acc}/identities/${made.id}`, { name: "Help desk", replyTo: null, signatureHtml: null })).json();
    assert.equal(edited.name, "Help desk");
    assert.equal(edited.replyTo, null);
    assert.equal(edited.signatureHtml, null);
    assert.equal(edited.email, ALIAS, "fields left out stay");

    const reply = await (await patch(env, `/api/accounts/${acc}/identities/${made.id}`, { replyTo: "Desk@fernpoint.test" })).json();
    assert.equal(reply.name, "Help desk", "a PATCH that only sets the reply-to keeps the display name");
    assert.equal(reply.replyTo, "desk@fernpoint.test");
    const signed = await (await patch(env, `/api/accounts/${acc}/identities/${made.id}`, { signatureHtml: "<p>Best</p>" })).json();
    assert.equal(signed.name, "Help desk", "a PATCH that only sets the signature keeps the display name");
    assert.equal(signed.replyTo, "desk@fernpoint.test", "and the reply-to");
    assert.equal(signed.signatureHtml, "<p>Best</p>");
    const none = await (await patch(env, `/api/accounts/${acc}/identities/${made.id}`, {})).json();
    assert.equal(none.name, "Help desk", "an empty PATCH changes nothing");
    await patch(env, `/api/accounts/${acc}/identities/${made.id}`, { replyTo: null });
    assert.equal(listIdentities(env.ctx.db, acc)[0]!.name, "Help desk", "kept in the database, not only in the reply");

    const renamed = await (await patch(env, `/api/accounts/${acc}/identities/${made.id}`, { email: "support@fernpoint.test" })).json();
    assert.equal(renamed.name, "Help desk");
    assert.equal(renamed.email, "support@fernpoint.test");

    const gone = await env.api(`/api/accounts/${acc}/identities/${made.id}`, { method: "DELETE" });
    assert.equal(gone.status, 200);
    assert.deepEqual(listIdentities(env.ctx.db, acc), []);
  });

  test("rejects the account's own address, duplicates and bad addresses", async () => {
    const own = await post(env, `/api/accounts/${acc}/identities`, { email: ME.toUpperCase() });
    assert.equal(own.status, 400);
    assert.match((await own.json()).error, /own address/);

    assert.equal((await post(env, `/api/accounts/${acc}/identities`, { email: "ops@fernpoint.test" })).status, 200);
    const dup = await post(env, `/api/accounts/${acc}/identities`, { email: "OPS@fernpoint.test" });
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /already added/);

    assert.equal((await post(env, `/api/accounts/${acc}/identities`, { email: "not an address" })).status, 400);
    assert.equal((await post(env, `/api/accounts/${acc}/identities`, { email: "a@fernpoint.test", replyTo: "nope" })).status, 400);

    const other = await (await post(env, `/api/accounts/${acc}/identities`, { email: "sales@fernpoint.test" })).json();
    const clash = await patch(env, `/api/accounts/${acc}/identities/${other.id}`, { email: "ops@fernpoint.test" });
    assert.equal(clash.status, 409);
    assert.equal((await patch(env, `/api/accounts/${acc}/identities/${other.id}`, { email: ME })).status, 400);
  });

  test("only the account's owner can touch its addresses", async () => {
    env.ctx.db.run("INSERT INTO users (id, email, name, created_at) VALUES ('usr_other', 'other@kettleby.test', 'Other', 1)");
    env.ctx.db.run("INSERT INTO accounts (id, user_id, provider, email, name, created_at) VALUES ('acc_other', 'usr_other', 'imap', 'ana@kettleby.test', 'Ana', 1)");
    assert.equal((await post(env, "/api/accounts/acc_other/identities", { email: "x@kettleby.test" })).status, 404);
    const mine = listIdentities(env.ctx.db, acc)[0]!;
    assert.equal((await patch(env, `/api/accounts/acc_other/identities/${mine.id}`, { name: "x" })).status, 404);
    assert.equal((await env.api(`/api/accounts/${acc}/identities/nope`, { method: "DELETE" })).status, 404);
    assert.equal((await post(env, "/api/accounts/nope/identities", { email: "x@kettleby.test" })).status, 404);
  });

  test("addresses that come from Gmail can't be edited or removed here", async () => {
    syncProviderIdentities(env.ctx.db, acc, [{ email: "billing@fernpoint.test", name: "Billing" }]);
    const row = listIdentities(env.ctx.db, acc).find((i) => i.source === "provider")!;
    for (const res of [await patch(env, `/api/accounts/${acc}/identities/${row.id}`, { name: "Mine" }), await env.api(`/api/accounts/${acc}/identities/${row.id}`, { method: "DELETE" })]) {
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /Gmail settings/);
    }
  });

  test("imported archives can't have send-as addresses", async () => {
    const archive = addAccount(env.ctx, LOCAL_USER_ID, "old@fernpoint.test", "archive");
    assert.equal((await post(env, `/api/accounts/${archive}/identities`, { email: "x@fernpoint.test" })).status, 400);
  });
});

describe("who a message may be sent as", () => {
  let env: TestEnv;
  let acc: string;
  before(() => {
    env = makeEnv();
    acc = addAccount(env.ctx, LOCAL_USER_ID, ME, "imap");
    addIdentity(env.ctx.db, LOCAL_USER_ID, acc, { email: ALIAS, name: "Fernpoint Help", replyTo: "desk@fernpoint.test" });
  });
  after(() => env.cleanup());

  const body = (extra: object = {}) => ({ accountId: acc, to: [{ name: "", email: "ana@kettleby.test" }], subject: "Hi", bodyHtml: "<p>Hi</p>", ...extra });
  const agent = (scopes: string[]): Actor => ({ kind: "agent", user: env.ctx.users.get(LOCAL_USER_ID)!, agent: env.ctx.agents.create(LOCAL_USER_ID, `bot-${scopes.join("")}`, scopes as never).agent });

  test("resolveFrom, ownAddresses and replyIdentity", () => {
    assert.deepEqual([...ownAddresses(env.ctx.db, acc)].sort(), [ALIAS, ME]);
    assert.deepEqual(resolveFrom(env.ctx.db, acc), { name: "Me", email: ME, replyTo: null });
    assert.deepEqual(resolveFrom(env.ctx.db, acc, ME.toUpperCase()), { name: "Me", email: ME, replyTo: null });
    assert.deepEqual(resolveFrom(env.ctx.db, acc, "HELP@fernpoint.test"), { name: "Fernpoint Help", email: ALIAS, replyTo: "desk@fernpoint.test" });
    assert.throws(() => resolveFrom(env.ctx.db, acc, "ceo@fernpoint.test"), /can't send from that address on this account/);

    assert.equal(replyIdentity(env.ctx.db, acc, ["Ann@kettleby.test", "HELP@fernpoint.test"]), ALIAS);
    assert.equal(replyIdentity(env.ctx.db, acc, [ME]), null, "the account's own address needs no identity");
    assert.equal(replyIdentity(env.ctx.db, acc, []), null);
  });

  test("a draft over the API keeps its address, and one that isn't the account's is refused", async () => {
    const bad = await post(env, "/api/drafts", body({ fromEmail: "ceo@fernpoint.test" }));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /can't send from that address on this account/);

    const made = await (await post(env, "/api/drafts", body({ fromEmail: ALIAS }))).json();
    assert.equal(made.fromEmail, ALIAS);
    assert.equal((await (await post(env, "/api/drafts", body())).json()).fromEmail, ME, "the account's own address when none is chosen");

    const kept = await (await env.api(`/api/drafts/${made.id}`, { method: "PUT", json: body({ subject: "Edited" }) })).json();
    assert.equal(kept.fromEmail, ALIAS, "an edit that doesn't mention it keeps it");
    assert.equal((await env.api(`/api/drafts/${made.id}`, { method: "PUT", json: body({ fromEmail: "ceo@fernpoint.test" }) })).status, 400);
    const reset = await (await env.api(`/api/drafts/${made.id}`, { method: "PUT", json: body({ fromEmail: ME }) })).json();
    assert.equal(reset.fromEmail, ME);
    assert.equal(env.ctx.db.get<{ f: string | null }>("SELECT from_email AS f FROM drafts WHERE id = ?", made.id)!.f, null, "stored as the account's own");
  });

  test("moving a draft to another account drops an address that account doesn't have", async () => {
    const second = addAccount(env.ctx, LOCAL_USER_ID, "sam@kettleby.test", "imap");
    const made = await (await post(env, "/api/drafts", body({ fromEmail: ALIAS }))).json();
    const moved = await (await env.api(`/api/drafts/${made.id}`, { method: "PUT", json: body({ accountId: second }) })).json();
    assert.equal(moved.fromEmail, "sam@kettleby.test");
  });

  test("a draft whose address was removed later still saves what's typed", async () => {
    const own = addAccount(env.ctx, LOCAL_USER_ID, "kim@fernpoint.test", "imap");
    const alias = "billing@fernpoint.test";
    const added = addIdentity(env.ctx.db, LOCAL_USER_ID, own, { email: alias, name: "Billing" });
    const draft = await (await post(env, "/api/drafts", body({ accountId: own, fromEmail: alias }))).json();
    assert.equal(draft.fromEmail, alias);
    assert.equal((await env.api(`/api/accounts/${own}/identities/${added.id}`, { method: "DELETE" })).status, 200);

    // The editor sends the From it holds with every autosave; it names the removed address and changes nothing.
    const saved = await env.api(`/api/drafts/${draft.id}`, { method: "PUT", json: body({ accountId: own, fromEmail: alias, bodyHtml: "<p>Typed after the removal</p>" }) });
    assert.equal(saved.status, 200);
    assert.match((await saved.json()).bodyHtml, /Typed after the removal/);
    const bare = await env.api(`/api/drafts/${draft.id}`, { method: "PUT", json: body({ accountId: own, bodyHtml: "<p>And again</p>" }) });
    assert.equal(bare.status, 200);
    assert.equal(env.ctx.db.get<{ f: string | null; b: string }>("SELECT from_email AS f, body_html AS b FROM drafts WHERE id = ?", draft.id)!.b, "<p>And again</p>");
    assert.equal(env.ctx.db.get<{ f: string | null }>("SELECT from_email AS f FROM drafts WHERE id = ?", draft.id)!.f, alias, "the stale address stays until someone picks another");

    // A newly chosen address is still checked, and sending still refuses the stale one.
    assert.equal((await env.api(`/api/drafts/${draft.id}`, { method: "PUT", json: body({ accountId: own, fromEmail: "ceo@fernpoint.test" }) })).status, 400);
    const send = await post(env, `/api/drafts/${draft.id}/send`, {});
    assert.equal(send.status, 400);
    assert.match((await send.json()).error, /can't send from that address/);
    const fixed = await env.api(`/api/drafts/${draft.id}`, { method: "PUT", json: body({ accountId: own, fromEmail: "kim@fernpoint.test" }) });
    assert.equal(fixed.status, 200);
    assert.equal((await fixed.json()).fromEmail, "kim@fernpoint.test");
  });

  test("agents can't spoof a From through the draft commands", async () => {
    const bot = agent(["read", "draft"]);
    await assert.rejects(env.ctx.commands.execute(bot, "drafts.create", { accountId: acc, to: ["ana@kettleby.test"], body: "Hi", fromEmail: "ceo@fernpoint.test" }), /can't send from that address on this account/);
    const ok = await env.ctx.commands.execute(bot, "drafts.create", { accountId: acc, to: ["ana@kettleby.test"], body: "Hi", fromEmail: ALIAS });
    assert.equal(ok.status, "done");
    const draft = (ok as { result: { id: string; fromEmail: string } }).result;
    assert.equal(draft.fromEmail, ALIAS);
    await assert.rejects(env.ctx.commands.execute(bot, "drafts.update", { draftId: draft.id, fromEmail: "ceo@kettleby.test" }), /can't send from that address/);
    const kept = await env.ctx.commands.execute(bot, "drafts.update", { draftId: draft.id, body: "Changed" });
    assert.equal((kept as { result: { fromEmail: string } }).result.fromEmail, ALIAS, "editing the text doesn't change the address");
    const listed = (await env.ctx.commands.execute(bot, "accounts.list", {})) as { result: { sendAs: string[] }[] };
    assert.deepEqual(listed.result.find((a) => a.sendAs.length)?.sendAs, [ALIAS]);
  });

  test("an approval preview names the address the message really goes out as", async () => {
    const bot = agent(["read", "draft", "send"]);
    const d = createDraft(env.ctx, LOCAL_USER_ID, { ...body({ fromEmail: ALIAS }), to: [{ name: "", email: "ana@kettleby.test" }], cc: [], bcc: [] } as never);
    const res = await env.ctx.commands.execute(bot, "drafts.send", { draftId: d.id });
    assert.equal(res.status, "pending_approval");
    const { preview } = env.ctx.db.get<{ preview: string }>("SELECT preview FROM approvals WHERE id = ?", (res as { approvalId: string }).approvalId)!;
    assert.match(preview, /^From: Fernpoint Help <help@fernpoint\.test>$/m);
    assert.equal(draftRecipients(env.ctx, LOCAL_USER_ID, d.id).from, ALIAS);
  });

  test("an approval preview shows where replies will go", async () => {
    const bot = agent(["read", "draft", "send"]);
    const preview = async (fromEmail?: string) => {
      const d = createDraft(env.ctx, LOCAL_USER_ID, { ...body(fromEmail ? { fromEmail } : {}), to: [{ name: "", email: "ana@kettleby.test" }], cc: [], bcc: [] } as never);
      const res = await env.ctx.commands.execute(bot, "drafts.send", { draftId: d.id });
      return env.ctx.db.get<{ preview: string }>("SELECT preview FROM approvals WHERE id = ?", (res as { approvalId: string }).approvalId)!.preview;
    };
    const viaAlias = await preview(ALIAS);
    assert.match(viaAlias, /^From: Fernpoint Help <help@fernpoint\.test>\nReply-To: desk@fernpoint\.test\nTo: /);
    assert.match(viaAlias, /\n\nHi$/, "a blank line still separates the headers from the text");
    assert.doesNotMatch(await preview(), /Reply-To/, "the account's own address has none");
  });

  test("replies default to the address the original was sent to; reply-all leaves all your addresses off", async () => {
    const bot = agent(["read", "draft"]);
    const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", acc)!;
    const ann = { name: "Ann", email: "ann@kettleby.test" };
    env.ctx.store.ingest(account, {
      messages: [
        msg({ from: ann, to: [{ name: "Fernpoint Help", email: ALIAS }], cc: [{ name: "Lee", email: "lee@kettleby.test" }, { name: "Sam", email: ME }], subject: "Question", remoteThreadId: "q1" }),
        msg({ from: ann, to: [{ name: "Sam", email: ME }], subject: "Direct", remoteThreadId: "q2" }),
      ],
      cursor: null,
      done: false,
    });
    const tid = (remote: string) => env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = ?", remote)!.id;
    const reply = (await env.ctx.commands.execute(bot, "drafts.create", { threadId: tid("q1"), body: "On it.", replyAll: true })) as { result: { fromEmail: string; cc: { email: string }[] } };
    assert.equal(reply.result.fromEmail, ALIAS);
    assert.deepEqual(reply.result.cc.map((a) => a.email), ["lee@kettleby.test"]);
    const direct = (await env.ctx.commands.execute(bot, "drafts.create", { threadId: tid("q2"), body: "Sure." })) as { result: { fromEmail: string } };
    assert.equal(direct.result.fromEmail, ME);
    await assert.rejects(env.ctx.commands.execute(bot, "drafts.create", { threadId: tid("q2"), body: "Sure.", fromEmail: "ceo@fernpoint.test" }), /can't send from/);
  });
});

describe("mail sent from an alias", () => {
  let env: TestEnv;
  let acc: string;
  before(() => {
    env = makeEnv();
    acc = addAccount(env.ctx, LOCAL_USER_ID, ME, "imap");
    // A "support@" address reads as automated, so if this were treated as inbound the thread would be a notification.
    addIdentity(env.ctx.db, LOCAL_USER_ID, acc, { email: "support@fernpoint.test", name: "Fernpoint Support" });
  });
  after(() => env.cleanup());

  test("is outgoing when the provider says so, whichever alias it went out as", () => {
    const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", acc)!;
    const ann = { name: "Ann", email: "ann@kettleby.test" };
    env.ctx.store.ingest(account, {
      messages: [msg({ from: { name: "Fernpoint Support", email: "Support@Fernpoint.test" }, to: [ann], outgoing: true, subject: "Your order", remoteThreadId: "t1", unread: false, folders: { inbox: false, sent: true, trash: false, spam: false } })],
      cursor: null,
      done: false,
    });
    const m = env.ctx.db.get<{ outgoing: number; is_bulk: number }>("SELECT outgoing, is_bulk FROM messages WHERE account_id = ?", acc)!;
    assert.deepEqual({ ...m }, { outgoing: 1, is_bulk: 0 });
    const t = env.ctx.db.get<{ category: string; in_sent: number; last_outbound_at: number | null; last_inbound_at: number | null; participants: string }>(
      "SELECT category, in_sent, last_outbound_at, last_inbound_at, participants FROM threads WHERE account_id = ?",
      acc,
    )!;
    assert.equal(t.category, "people");
    assert.equal(t.in_sent, 1);
    assert.ok(t.last_outbound_at);
    assert.equal(t.last_inbound_at, null);
    assert.deepEqual(JSON.parse(t.participants).map((p: { email: string }) => p.email), ["ann@kettleby.test"], "your own addresses aren't listed as participants");
    const contacts = env.ctx.db.all<{ email: string; sent_count: number; received_count: number }>("SELECT email, sent_count, received_count FROM contacts WHERE account_id = ?", acc);
    assert.deepEqual(contacts.map((c) => ({ ...c })), [{ email: "ann@kettleby.test", sent_count: 1, received_count: 0 }], "the recipient counts as sent to; you don't become your own contact");
  });

  test("mail the provider calls inbound stays inbound even when its From is one of our aliases", () => {
    const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", acc)!;
    env.ctx.store.ingest(account, {
      messages: [
        msg({
          from: { name: "Fernpoint Support", email: "support@fernpoint.test" },
          to: [{ name: "Sam", email: ME }, { name: "Victim", email: "victim@elsewhere.test" }],
          outgoing: false,
          subject: "Forged",
          remoteThreadId: "forged",
        }),
      ],
      cursor: null,
      done: false,
    });
    const m = env.ctx.db.get<{ outgoing: number }>("SELECT outgoing FROM messages WHERE subject = 'Forged'")!;
    assert.equal(m.outgoing, 0);
    const t = env.ctx.db.get<{ in_sent: number; last_outbound_at: number | null; last_inbound_at: number | null }>("SELECT in_sent, last_outbound_at, last_inbound_at FROM threads WHERE remote_id = 'forged'")!;
    assert.equal(t.in_sent, 0);
    assert.equal(t.last_outbound_at, null);
    assert.ok(t.last_inbound_at);
    assert.deepEqual(env.ctx.db.all("SELECT email FROM contacts WHERE account_id = ? AND sent_count > 0 AND email IN ('victim@elsewhere.test', ?)", acc, ME), [], "nobody becomes someone you have written to");
  });

  test("mail in the Sent folder from an alias counts as outgoing", () => {
    const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", acc)!;
    env.ctx.store.ingest(account, {
      messages: [msg({ from: { name: "Fernpoint Support", email: "support@fernpoint.test" }, to: [{ name: "Bo", email: "bo@kettleby.test" }], outgoing: true, subject: "Sent copy", remoteThreadId: "sent-copy", unread: false, folders: { inbox: false, sent: true, trash: false, spam: false } })],
      cursor: null,
      done: false,
    });
    assert.equal(env.ctx.db.get<{ outgoing: number }>("SELECT outgoing FROM messages WHERE subject = 'Sent copy'")!.outgoing, 1);
    assert.equal(env.ctx.db.get<{ sent_count: number }>("SELECT sent_count FROM contacts WHERE account_id = ? AND email = 'bo@kettleby.test'", acc)!.sent_count, 1);
  });

  test("a copy sent to yourself is ours once its Sent copy syncs, whichever mailbox came first", () => {
    const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", acc)!;
    const note = { subject: "Note to self", messageIdHeader: "<self@t>", from: { name: "Sam", email: ME }, to: [{ name: "Sam", email: ME }] };
    const sent = { inbox: false, sent: true, trash: false, spam: false };
    env.ctx.store.ingest(account, { messages: [msg({ ...note, remoteId: "self-inbox", outgoing: false, remoteThreadId: "self" })], cursor: null, done: false });
    assert.equal(env.ctx.db.get<{ outgoing: number }>("SELECT outgoing FROM messages WHERE subject = 'Note to self'")!.outgoing, 0);
    env.ctx.store.ingest(account, { messages: [msg({ ...note, remoteId: "self-sent", outgoing: true, folders: sent, remoteThreadId: "self" })], cursor: null, done: false });
    assert.equal(env.ctx.db.all("SELECT outgoing FROM messages WHERE subject = 'Note to self'").length, 1, "one message in two mailboxes");
    assert.equal(env.ctx.db.get<{ outgoing: number }>("SELECT outgoing FROM messages WHERE subject = 'Note to self'")!.outgoing, 1);
    assert.equal(env.ctx.db.get<{ last_inbound_at: number | null }>("SELECT last_inbound_at FROM threads WHERE remote_id = 'self'")!.last_inbound_at, null);
    // Seen again from the Inbox, it stays ours.
    env.ctx.store.ingest(account, { messages: [msg({ ...note, remoteId: "self-inbox-2", outgoing: false, remoteThreadId: "self" })], cursor: null, done: false });
    assert.equal(env.ctx.db.get<{ outgoing: number }>("SELECT outgoing FROM messages WHERE subject = 'Note to self'")!.outgoing, 1);
  });

  test("a provider that can't tell falls back to our own addresses, aliases included", () => {
    const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", acc)!;
    env.ctx.store.ingest(account, {
      messages: [msg({ from: { name: "Fernpoint Support", email: "support@fernpoint.test" }, outgoing: undefined, subject: "Unclassified", remoteThreadId: "unclassified" })],
      cursor: null,
      done: false,
    });
    assert.equal(env.ctx.db.get<{ outgoing: number }>("SELECT outgoing FROM messages WHERE subject = 'Unclassified'")!.outgoing, 1);
  });
});

describe("the external send policy", () => {
  let env: TestEnv;
  before(() => {
    env = makeEnv();
  });
  after(() => env.cleanup());

  const agent = (name: string): Actor => ({ kind: "agent", user: env.ctx.users.get(LOCAL_USER_ID)!, agent: env.ctx.agents.create(LOCAL_USER_ID, name, ["read", "draft", "send"], { send: "external" }).agent });
  const send = async (bot: Actor, accountId: string, fromEmail: string | undefined, to: string[]) => {
    const made = await env.ctx.commands.execute(bot, "drafts.create", { accountId, to, body: "Hello", fromEmail });
    return env.ctx.commands.execute(bot, "drafts.send", { draftId: (made as { result: { id: string } }).result.id });
  };
  const reason = (res: { status: string; approvalId?: string }) => env.ctx.db.get<{ reason: string }>("SELECT reason FROM approvals WHERE id = ?", res.approvalId!)?.reason;

  test("is judged against the account's own domain, not the From an agent picked", async () => {
    const acc = addAccount(env.ctx, LOCAL_USER_ID, "sam@fernpoint.test", "imap");
    addIdentity(env.ctx.db, LOCAL_USER_ID, acc, { email: "sam@kettleby.test", name: "Sam at Kettleby" });
    const bot = agent("outside");
    const inside = await send(bot, acc, undefined, ["ben@fernpoint.test"]);
    assert.equal(inside.status, "done", "a colleague on the account's own domain needs no approval");

    // The recipient's domain is the alias's, so judging by the From would have let this through.
    const spoof = (await send(bot, acc, "sam@kettleby.test", ["ana@kettleby.test"])) as { status: string; approvalId?: string };
    assert.equal(spoof.status, "pending_approval");
    assert.equal(reason(spoof), "Sending as sam@kettleby.test to people outside fernpoint.test: ana@kettleby.test", "the reason names the address it goes out as");
  });

  test("a personal-mail account has no inside: every recipient waits for approval", async () => {
    const acc = addAccount(env.ctx, LOCAL_USER_ID, "sam@gmail.com", "imap");
    const bot = agent("personal");
    const res = (await send(bot, acc, undefined, ["friend@gmail.com"])) as { status: string; approvalId?: string };
    assert.equal(res.status, "pending_approval", "another gmail.com address is not a colleague");
    assert.equal(reason(res), "Sending as sam@gmail.com to friend@gmail.com");
  });
});

describe("one-key unsubscribe", () => {
  test("sends from the account's own address even when the list wrote to an alias", async () => {
    const env = makeEnv();
    try {
      const acc = addAccount(env.ctx, LOCAL_USER_ID, ME, "imap");
      addIdentity(env.ctx.db, LOCAL_USER_ID, acc, { email: ALIAS, name: "Fernpoint Help" });
      const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", acc)!;
      env.ctx.store.ingest(account, {
        messages: [msg({ from: { name: "Weekly", email: "news@lists.test" }, to: [{ name: "", email: ALIAS }], listUnsubscribe: "<mailto:leave@lists.test?subject=unsubscribe>", remoteThreadId: "list" })],
        cursor: null,
        done: false,
      });
      const threadId = env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = 'list'")!.id;
      const res = await unsubscribe(env.ctx, LOCAL_USER_ID, threadId);
      assert.equal(res.method, "email");
      const draft = env.ctx.db.get<{ from_email: string | null; to_json: string }>("SELECT from_email, to_json FROM drafts WHERE account_id = ?", acc)!;
      assert.equal(draft.from_email, null, "NULL is the account's own address");
      assert.equal(JSON.parse(draft.to_json)[0].email, "leave@lists.test");
    } finally {
      env.cleanup();
    }
  });
});

describe("sending as an alias through Gmail", () => {
  let env: TestEnv;
  let acc: string;
  let stub: FetchStub;
  const sent: string[] = [];
  before(() => {
    env = makeEnv();
    acc = addAccount(env.ctx, LOCAL_USER_ID, ME, "gmail");
    env.ctx.db.run("UPDATE accounts SET auth_enc = ? WHERE id = ?", env.ctx.secrets.seal({ accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }), acc);
    addIdentity(env.ctx.db, LOCAL_USER_ID, acc, { email: ALIAS, name: "Fernpoint Help", replyTo: "desk@fernpoint.test" });
    stub = new FetchStub().on("POST", `${GMAIL}/messages/send`, (call: Call) => {
      sent.push(Buffer.from((JSON.parse(call.body) as { raw: string }).raw, "base64url").toString());
      return json({ id: `g${sent.length}`, threadId: `gt${sent.length}` });
    });
  });
  after(() => {
    stub.restore();
    env.cleanup();
  });

  const draft = (fromEmail?: string) =>
    createDraft(env.ctx, LOCAL_USER_ID, { accountId: acc, to: [{ name: "Ann", email: "ann@kettleby.test" }], cc: [], bcc: [], subject: "Your order", bodyHtml: "<p>Shipped.</p>", fromEmail });
  const status = (id: string) => env.ctx.db.get<{ status: string; error: string | null }>("SELECT status, error FROM drafts WHERE id = ?", id)!;

  test("the message goes out From the alias with its Reply-To, and the saved copy shows the alias", async () => {
    const d = draft(ALIAS);
    sendDraft(env.ctx, LOCAL_USER_ID, d.id, { instant: true, markDone: false });
    await env.ctx.sync.sendDue(Date.now() + 1000);
    assert.equal(status(d.id).status, "sent", status(d.id).error ?? "");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^From: Fernpoint Help <help@fernpoint\.test>\r?$/m);
    assert.match(sent[0]!, /^Reply-To: desk@fernpoint\.test\r?$/m);
    const m = env.ctx.db.get<{ from_email: string; reply_to: string | null; outgoing: number }>("SELECT from_email, reply_to, outgoing FROM messages WHERE account_id = ?", acc)!;
    assert.deepEqual({ ...m }, { from_email: ALIAS, reply_to: "desk@fernpoint.test", outgoing: 1 });
  });

  test("the account's own address sends as before, with no Reply-To", async () => {
    const d = draft();
    sendDraft(env.ctx, LOCAL_USER_ID, d.id, { instant: true, markDone: false });
    await env.ctx.sync.sendDue(Date.now() + 1000);
    assert.equal(status(d.id).status, "sent");
    assert.match(sent[1]!, /^From: Me <sam@fernpoint\.test>\r?$/m);
    assert.doesNotMatch(sent[1]!, /^Reply-To:/m);
  });

  test("an address removed after queuing fails the draft instead of sending as someone else", async () => {
    const extra = addIdentity(env.ctx.db, LOCAL_USER_ID, acc, { email: "temp@fernpoint.test" });
    const d = draft("temp@fernpoint.test");
    sendDraft(env.ctx, LOCAL_USER_ID, d.id, { instant: true, markDone: false });
    env.ctx.db.run("DELETE FROM identities WHERE id = ?", extra.id);
    const before = sent.length;
    await env.ctx.sync.sendDue(Date.now() + 1000);
    assert.equal(status(d.id).status, "failed");
    assert.match(status(d.id).error!, /can't send from that address on this account/);
    assert.equal(sent.length, before, "nothing left");
    assert.throws(() => sendDraft(env.ctx, LOCAL_USER_ID, d.id, { instant: true, markDone: false }), /can't send from that address/);
  });
});

describe("importing Gmail's send-as list during sync", () => {
  let env: TestEnv;
  let acc: string;
  let stub: FetchStub;
  let listing: () => Response;
  let calls = 0;
  const sendAs = (email: string, extra: object = {}) => ({ sendAsEmail: email, displayName: "", ...extra });
  const rows = () => listIdentities(env.ctx.db, acc).map((i) => `${i.source}:${i.email}`).sort();
  const account = () => env.ctx.db.get<{ sync_status: string; sync_error: string | null }>("SELECT sync_status, sync_error FROM accounts WHERE id = ?", acc)!;

  before(() => {
    env = makeEnv();
    acc = addAccount(env.ctx, LOCAL_USER_ID, ME, "gmail");
    env.ctx.db.run("UPDATE accounts SET auth_enc = ? WHERE id = ?", env.ctx.secrets.seal({ accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }), acc);
    stub = new FetchStub()
      .on("GET", `${GMAIL}/profile`, { emailAddress: ME, historyId: "10" })
      .on("GET", `${GMAIL}/messages`, {})
      .on("GET", `${GMAIL}/history`, { historyId: "10" })
      .on("GET", `${GMAIL}/settings/sendAs`, () => {
        calls += 1;
        return listing();
      });
  });
  after(() => {
    stub.restore();
    env.cleanup();
  });

  test("adds verified aliases, skipping the primary address and ones still waiting for verification", async () => {
    listing = () =>
      json({
        sendAs: [
          sendAs(ME, { isPrimary: true, isDefault: true, verificationStatus: "accepted" }),
          sendAs(ALIAS, { displayName: "Fernpoint Help", replyToAddress: "desk@fernpoint.test", signature: "<p>Best,<br>Help</p><script>x()</script>", verificationStatus: "accepted" }),
          sendAs("legacy@fernpoint.test"),
          sendAs("pending@fernpoint.test", { verificationStatus: "pending" }),
        ],
      });
    addIdentity(env.ctx.db, LOCAL_USER_ID, acc, { email: "mine@fernpoint.test", name: "Added by hand" });
    await env.ctx.sync.syncAccount(acc);
    assert.equal(account().sync_status, "idle", account().sync_error ?? "");
    assert.deepEqual(rows(), ["manual:mine@fernpoint.test", `provider:${ALIAS}`, "provider:legacy@fernpoint.test"]);
    const help = listIdentities(env.ctx.db, acc).find((i) => i.email === ALIAS)!;
    assert.equal(help.name, "Fernpoint Help");
    assert.equal(help.replyTo, "desk@fernpoint.test");
    assert.equal(help.signatureHtml, "<p>Best,<br />Help</p>");
    assert.equal(calls, 1);
  });

  test("reads the list at most every six hours", async () => {
    await env.ctx.sync.syncAccount(acc);
    await env.ctx.sync.syncAccount(acc);
    assert.equal(calls, 1);
  });

  test("addresses Gmail stops listing are removed; ones added by hand stay", async () => {
    listing = () => json({ sendAs: [sendAs(ME, { isPrimary: true }), sendAs(ALIAS, { displayName: "Fernpoint Help" })] });
    await env.ctx.sync.forget(acc); // as after signing in again
    await env.ctx.sync.syncAccount(acc);
    assert.equal(calls, 2);
    assert.deepEqual(rows(), ["manual:mine@fernpoint.test", `provider:${ALIAS}`]);
  });

  test("a missing permission doesn't fail the sync or lose what's stored", async () => {
    listing = () => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } }, 403);
    await env.ctx.sync.forget(acc);
    await env.ctx.sync.syncAccount(acc);
    assert.equal(calls, 3);
    assert.equal(account().sync_status, "idle", account().sync_error ?? "");
    assert.deepEqual(rows(), ["manual:mine@fernpoint.test", `provider:${ALIAS}`]);
  });

  test("an outage while listing keeps what's stored too", async () => {
    listing = () => json({ error: { code: 500, message: "Backend error" } }, 500);
    await env.ctx.sync.forget(acc);
    await env.ctx.sync.syncAccount(acc);
    assert.equal(account().sync_status, "idle");
    assert.deepEqual(rows(), ["manual:mine@fernpoint.test", `provider:${ALIAS}`]);
  });
});
