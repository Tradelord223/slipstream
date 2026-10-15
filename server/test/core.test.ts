import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { compile, ftsQuery, parse } from "../src/mail/query.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";

const ana = { name: "Ana Silva", email: "ana@acme.test" };
const news = { name: "Weekly", email: "letters@news.test" };

describe("search language", () => {
  test("parses operators, negation, OR groups and phrases", () => {
    const clauses = parse('from:ana -is:unread subject:"q3 plan" invoice OR receipt');
    assert.deepEqual(
      clauses.map((c) => c.map((t) => `${t.neg ? "-" : ""}${t.key ?? "_"}:${t.value}`)),
      [["from:ana"], ["-is:unread"], ["subject:q3 plan"], ["_:invoice", "_:receipt"]],
    );
  });

  test("free text becomes prefix-matching FTS terms, never raw FTS syntax", () => {
    assert.equal(ftsQuery("lane group"), '"lane"* "group"*');
    assert.equal(ftsQuery('NEAR( "x" OR'), '"NEAR"* "x"* "OR"*');
    assert.equal(ftsQuery("!!!"), null);
  });

  test("location operators mark the query as scoped", () => {
    assert.equal(compile("in:done").scoped, true);
    assert.equal(compile("from:ana").scoped, false);
  });

  test("LIKE wildcards in user input are escaped", () => {
    const c = compile("from:100%_off");
    assert.ok(c.params.includes("%100\\%\\_off%"));
  });
});

describe("store, splits and triage", () => {
  let env: TestEnv;
  let account: AccountRow;

  before(() => {
    env = makeEnv();
    const id = addAccount(env.ctx, LOCAL_USER_ID);
    account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", id)!;
  });
  after(() => env.cleanup());

  test("replies thread with their parent through References when the provider has no thread id", () => {
    const parent = msg({ from: ana, subject: "Lunch?", messageIdHeader: "<p1@acme.test>" });
    const reply = msg({
      from: { name: "Me", email: "me@example.test" },
      to: [ana],
      subject: "Re: Lunch?",
      inReplyTo: "<p1@acme.test>",
      references: ["<p1@acme.test>"],
      sentAt: parent.sentAt + 60_000,
      folders: { inbox: false, sent: true, trash: false, spam: false },
    });
    env.ctx.store.ingest(account, { messages: [parent, reply], cursor: null, done: true });
    const t = env.ctx.db.get<{ subject: string; message_count: number; in_sent: number; category: string }>(
      "SELECT subject, message_count, in_sent, category FROM threads WHERE subject = 'Lunch?'",
    )!;
    assert.equal(t.message_count, 2);
    assert.equal(t.in_sent, 1);
    assert.equal(t.category, "important");
  });

  test("bulk mail lands in Other; people land in Important", async () => {
    env.ctx.store.ingest(account, {
      messages: [msg({ from: news, subject: "Issue 9", listUnsubscribe: "<https://news.test/u>", remoteThreadId: "nl9" })],
      cursor: null,
      done: true,
    });
    const splits = (await (await env.api("/api/bootstrap")).json()).splits as { id: string; name: string }[];
    const list = async (name: string) => {
      const id = splits.find((s) => s.name === name)!.id;
      const r = await (await env.api(`/api/threads?view=split&split=${id}`)).json();
      return (r.threads as { subject: string }[]).map((t) => t.subject);
    };
    assert.ok((await list("Other")).includes("Issue 9"));
    assert.ok(!(await list("Important")).includes("Issue 9"));
  });

  test("custom splits pull their threads out of Important and Other", async () => {
    await env.api("/api/splits", { method: "POST", json: { name: "Acme", query: "from:@acme.test" } });
    const boot = await (await env.api("/api/bootstrap")).json();
    const important = boot.splits.find((s: { name: string }) => s.name === "Important").id;
    const r = await (await env.api(`/api/threads?view=split&split=${important}`)).json();
    assert.ok(!r.threads.some((t: { subject: string }) => t.subject === "Lunch?"));
  });

  test("done is instant and local, waits out the undo window, and undo cancels the provider write", async () => {
    env.ctx.store.ingest(account, { messages: [msg({ from: ana, subject: "Undo me", remoteThreadId: "u1" })], cursor: null, done: true });
    const id = env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = 'u1'")!.id;

    const res = await (await env.api("/api/triage", { method: "POST", json: { kind: "done", threadIds: [id] } })).json();
    assert.equal(env.ctx.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox, 0);
    const queued = env.ctx.db.get<{ status: string; run_after: number }>("SELECT status, run_after FROM pending_actions WHERE undo_group = ?", res.undoToken)!;
    assert.equal(queued.status, "queued");
    assert.ok(queued.run_after > Date.now() + 5_000, "provider write waits for the undo window");

    await env.api("/api/undo", { method: "POST", json: { undoToken: res.undoToken } });
    assert.equal(env.ctx.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox, 1);
    assert.equal(env.ctx.db.get<{ status: string }>("SELECT status FROM pending_actions WHERE undo_group = ?", res.undoToken)!.status, "cancelled");
  });

  test("a sync that still shows the old state doesn't resurrect a thread with a queued action", async () => {
    env.ctx.store.ingest(account, { messages: [msg({ from: ana, subject: "Stay done", remoteThreadId: "s1", remoteId: "s1m" })], cursor: null, done: true });
    const id = env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = 's1'")!.id;
    await env.api("/api/triage", { method: "POST", json: { kind: "done", threadIds: [id] } });
    env.ctx.store.ingest(account, { messages: [], flagUpdates: [{ remoteId: "s1m", folders: { inbox: true } }], cursor: null, done: true });
    assert.equal(env.ctx.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox, 0);
  });

  test("reminders come back to the top of the inbox; a reply cancels a follow-up", async () => {
    env.ctx.store.ingest(account, { messages: [msg({ from: ana, subject: "Later", remoteThreadId: "r1" })], cursor: null, done: true });
    const id = env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = 'r1'")!.id;
    await env.api("/api/triage", { method: "POST", json: { kind: "snooze", threadIds: [id], until: Date.now() + 60_000 } });
    assert.equal(env.ctx.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox, 0);
    env.ctx.sync.wakeReminders(Date.now() + 61_000);
    const t = env.ctx.db.get<{ in_inbox: number; reminded_at: number; snoozed_until: number | null }>("SELECT in_inbox, reminded_at, snoozed_until FROM threads WHERE id = ?", id)!;
    assert.equal(t.in_inbox, 1);
    assert.ok(t.reminded_at);
    assert.equal(t.snoozed_until, null);

    // Follow-up: I wrote last, then they replied → no reminder.
    env.ctx.db.run("UPDATE threads SET follow_up_at = ?, last_outbound_at = 1, last_inbound_at = 2, in_inbox = 0 WHERE id = ?", Date.now() - 1, id);
    env.ctx.sync.wakeReminders();
    assert.equal(env.ctx.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox, 0);
  });

  test("full-text search finds body words and respects ownership", async () => {
    env.ctx.store.ingest(account, { messages: [msg({ from: ana, subject: "Specs", bodyText: "The tolerance is 0.2mm on the bracket", remoteThreadId: "f1" })], cursor: null, done: true });
    const r = await (await env.api("/api/threads?view=search&q=bracket")).json();
    assert.deepEqual(r.threads.map((t: { subject: string }) => t.subject), ["Specs"]);
    // Another user's account must never show up.
    const other = env.ctx.db.run("INSERT INTO users (id, email, name, created_at) VALUES ('usr_x','x@x.test','X',0)");
    assert.ok(other);
    const otherAcc = addAccount(env.ctx, "usr_x", "x@x.test");
    env.ctx.store.ingest(env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", otherAcc)!, {
      messages: [msg({ from: ana, subject: "Secret bracket", remoteThreadId: "f2" })],
      cursor: null,
      done: true,
    });
    const r2 = await (await env.api("/api/threads?view=search&q=bracket")).json();
    assert.equal(r2.threads.length, 1);
    const foreign = env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = 'f2'")!.id;
    assert.equal((await env.api(`/api/threads/${foreign}`)).status, 404);
    const t = await (await env.api("/api/triage", { method: "POST", json: { kind: "done", threadIds: [foreign] } })).json();
    assert.deepEqual(t.threadIds, []);
  });

  test("outgoing HTML is sanitized before it's queued to send", async () => {
    const draft = await (
      await env.api("/api/drafts", {
        method: "POST",
        json: { accountId: account.id, to: [ana], subject: "Hi", bodyHtml: '<p onclick="x()">Hi<script>alert(1)</script><img src="javascript:alert(1)"></p>' },
      })
    ).json();
    const sent = await env.api(`/api/drafts/${draft.id}/send`, { method: "POST", json: {} });
    assert.equal(sent.status, 200);
    const row = env.ctx.db.get<{ body_html: string; status: string }>("SELECT body_html, status FROM drafts WHERE id = ?", draft.id)!;
    assert.equal(row.status, "scheduled");
    assert.doesNotMatch(row.body_html, /script|onclick|javascript:/i);
    const cancel = await env.api(`/api/drafts/${draft.id}/cancel`, { method: "POST" });
    assert.equal(cancel.status, 200);
  });
});
