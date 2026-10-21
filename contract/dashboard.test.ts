/**
 * The dashboard's API, black-box: everything the web app relies on, so any server implementation
 * can be checked against what people use, not just what agents use.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { human, startServer, type Server } from "./harness.ts";

let server: Server;
let h: ReturnType<typeof human>;
before(async () => {
  server = await startServer();
  h = human(server.url);
});
after(async () => server.stop());

type Row = { id: string; subject: string; unread: boolean; starred: boolean; labels: string[]; inInbox: boolean; participants: { email: string }[] };

describe("reading", () => {
  test("bootstrap describes the user, accounts, splits and features", async () => {
    const b = (await h("/api/bootstrap")).body;
    assert.equal(b.mode, "local");
    assert.ok(b.accounts.length >= 1 && b.accounts[0].email);
    assert.deepEqual(b.splits.slice(0, 2).map((s: { name: string }) => s.name), ["Important", "Updates"]);
    assert.equal(typeof b.features.undoSendSeconds, "number");
  });

  test("inbox, splits, search, paging and counts agree", async () => {
    const inbox = (await h("/api/threads?view=inbox&limit=5")).body;
    assert.equal(inbox.threads.length, 5);
    assert.ok(inbox.next);
    const page2 = (await h(`/api/threads?view=inbox&limit=5&before=${encodeURIComponent(inbox.next)}`)).body.threads as Row[];
    assert.ok(page2.every((t) => !inbox.threads.some((x: Row) => x.id === t.id)), "pages don't overlap");

    const boot = (await h("/api/bootstrap")).body;
    const counts = (await h("/api/counts")).body;
    for (const s of boot.splits) {
      const list = (await h(`/api/threads?view=split&split=${s.id}&limit=500`)).body.threads as Row[];
      assert.equal(list.length, counts.splits[s.id].total, `${s.name} count matches its list`);
    }
    const found = (await h(`/api/threads?view=search&q=${encodeURIComponent("from:priya has:attachment")}`)).body.threads as Row[];
    assert.deepEqual(found.map((t) => t.subject), ["Dispatch dashboard — round 2 feedback"]);
  });

  test("a conversation has its messages, attachments and context", async () => {
    const t = ((await h(`/api/threads?view=search&q=${encodeURIComponent("from:priya has:attachment")}`)).body.threads as Row[])[0]!;
    const d = (await h(`/api/threads/${t.id}`)).body;
    assert.equal(d.messages.length, 2);
    assert.equal(d.messages[1].attachments[0].filename, "dispatch-r2-markup.pdf");
    assert.ok(d.messages.every((m: { from: { email: string }; sentAt: number }) => m.from.email && m.sentAt));
    assert.equal((await h("/api/threads/thr_missing")).status, 404);
    const contact = (await h(`/api/contacts/${encodeURIComponent("priya.raman@kettlebyfreight.com")}`)).body;
    assert.equal(contact.name, "Priya Raman");
    const suggest = (await h("/api/contacts?q=pri")).body.contacts as { email: string }[];
    assert.ok(suggest.some((c) => c.email === "priya.raman@kettlebyfreight.com"));
  });
});

describe("triage", () => {
  test("every kind applies and undoes", async () => {
    const [t] = (await h("/api/threads?view=inbox&limit=1")).body.threads as Row[];
    const kinds: [string, (r: Row) => boolean][] = [
      ["star", (r) => r.starred],
      ["unstar", (r) => !r.starred],
      ["unread", (r) => r.unread],
      ["read", (r) => !r.unread],
    ];
    for (const [kind, check] of kinds) {
      await h("/api/triage", { method: "POST", json: { kind, threadIds: [t!.id] } });
      assert.ok(check((await h(`/api/threads/${t!.id}`)).body.thread), kind);
    }
    const done = (await h("/api/triage", { method: "POST", json: { kind: "done", threadIds: [t!.id] } })).body;
    assert.equal((await h(`/api/threads/${t!.id}`)).body.thread.inInbox, false);
    await h("/api/undo", { method: "POST", json: { undoToken: done.undoToken } });
    assert.equal((await h(`/api/threads/${t!.id}`)).body.thread.inInbox, true);

    const until = Date.now() + 3_600_000;
    await h("/api/triage", { method: "POST", json: { kind: "snooze", threadIds: [t!.id], until } });
    const snoozed = (await h(`/api/threads/${t!.id}`)).body.thread;
    assert.equal(snoozed.snoozedUntil, until);
    assert.equal(snoozed.inInbox, false);
    await h("/api/triage", { method: "POST", json: { kind: "unsnooze", threadIds: [t!.id] } });

    await h("/api/triage", { method: "POST", json: { kind: "addLabel", threadIds: [t!.id], label: "Contract" } });
    assert.ok((await h(`/api/threads/${t!.id}`)).body.thread.labels.includes("Contract"));
    assert.equal((await h("/api/triage", { method: "POST", json: { kind: "nope", threadIds: [t!.id] } })).status, 400);
  });

  test("get me to zero and unsubscribe", async () => {
    const zero = (await h("/api/zero", { method: "POST", json: { olderThanDays: 0, keepStarred: true } })).body;
    assert.ok(zero.threadIds.length > 0);
    assert.equal((await h("/api/counts")).body.inbox.total, (await h("/api/threads?view=inbox&limit=500")).body.threads.length);
    await h("/api/undo", { method: "POST", json: { undoToken: zero.undoToken } });
    const news = ((await h(`/api/threads?view=search&q=${encodeURIComponent("from:tidewrack in:inbox")}`)).body.threads as Row[])[0]!;
    const unsub = (await h(`/api/threads/${news.id}/unsubscribe`, { method: "POST" })).body;
    assert.equal(unsub.method, "web");
    assert.match(unsub.url, /^https:\/\/tidewrack\.news\/unsubscribe/);
  });
});

describe("writing", () => {
  test("draft lifecycle: create, edit, send with undo window, cancel, send later, delete", async () => {
    const accountId = (await h("/api/bootstrap")).body.accounts[0].id;
    const created = (await h("/api/drafts", { method: "POST", json: { accountId, to: [{ name: "Sam", email: "sam@fernpoint.co" }], subject: "Hi", bodyHtml: "<p>One</p>" } })).body;
    assert.equal(created.status, "draft");
    const edited = (await h(`/api/drafts/${created.id}`, { method: "PUT", json: { accountId, to: created.to, subject: "Hi there", bodyHtml: "<p>Two</p>" } })).body;
    assert.equal(edited.subject, "Hi there");
    const sent = (await h(`/api/drafts/${created.id}/send`, { method: "POST", json: {} })).body;
    assert.ok(sent.sendAt > Date.now());
    assert.equal((await h(`/api/drafts/${created.id}/cancel`, { method: "POST" })).body.status, "draft");
    const later = Date.now() + 86_400_000;
    assert.equal((await h(`/api/drafts/${created.id}/send`, { method: "POST", json: { sendAt: later } })).body.sendAt, later);
    assert.ok(((await h("/api/drafts")).body.drafts as { id: string; status: string }[]).some((d) => d.id === created.id && d.status === "scheduled"));
    await h(`/api/drafts/${created.id}/cancel`, { method: "POST" });
    assert.equal((await h(`/api/drafts/${created.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await h(`/api/drafts/${created.id}`)).status, 404);
    const empty = (await h("/api/drafts", { method: "POST", json: { accountId } })).body;
    assert.equal((await h(`/api/drafts/${empty.id}/send`, { method: "POST", json: {} })).status, 400, "needs a recipient");
  });

  test("attachments upload to a draft and come back", async () => {
    const accountId = (await h("/api/bootstrap")).body.accounts[0].id;
    const d = (await h("/api/drafts", { method: "POST", json: { accountId } })).body;
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
    const res = await fetch(`${server.url}/api/drafts/${d.id}/attachments`, { method: "POST", headers: { "x-slipstream": "1" }, body: form });
    const withFile = await res.json();
    assert.deepEqual(withFile.attachments.map((a: { filename: string; size: number }) => [a.filename, a.size]), [["note.txt", 5]]);
  });
});

describe("preferences", () => {
  test("settings, splits and snippets round-trip", async () => {
    await h("/api/settings", { method: "PUT", json: { theme: "light", keymap: { done: "d" } } });
    const s = (await h("/api/bootstrap")).body.settings;
    assert.equal(s.theme, "light");
    assert.deepEqual(s.keymap, { done: "d" });

    const split = (await h("/api/splits", { method: "POST", json: { name: "Kettleby", query: "from:@kettlebyfreight.com" } })).body;
    const splits = (await h("/api/bootstrap")).body.splits as { id: string }[];
    await h("/api/splits-order", { method: "PUT", json: { ids: [split.id, ...splits.filter((x) => x.id !== split.id).map((x) => x.id)] } });
    assert.equal((await h("/api/bootstrap")).body.splits[0].id, split.id);
    assert.equal((await h(`/api/splits/${split.id}`, { method: "DELETE" })).status, 200);

    const snip = (await h("/api/snippets", { method: "POST", json: { name: "Thanks", bodyHtml: "<p>Thanks {first_name}!</p>" } })).body;
    assert.ok(((await h("/api/snippets")).body.snippets as { id: string }[]).some((x) => x.id === snip.id));
    await h(`/api/snippets/${snip.id}/used`, { method: "POST" });
    assert.equal(((await h("/api/snippets")).body.snippets as { id: string; useCount: number }[]).find((x) => x.id === snip.id)!.useCount, 1);
  });

  test("accounts: presets, import of an mbox, removal", async () => {
    const presets = (await h("/api/accounts/presets")).body.presets as { id: string }[];
    assert.ok(presets.some((p) => p.id === "gmail") && presets.some((p) => p.id === "fastmail"));
    const mbox = [
      "From MAILER-DAEMON Thu Oct 15 10:00:00 2026",
      "From: Old Friend <old@friend.test>",
      "To: me@example.test",
      "Subject: Archived hello",
      "Message-ID: <archived-1@friend.test>",
      "Date: Thu, 15 Oct 2026 10:00:00 +0000",
      "X-Gmail-Labels: Inbox,Starred,Family",
      "",
      "From the archive, with love.",
      "",
    ].join("\n");
    const form = new FormData();
    form.append("file", new Blob([mbox]), "takeout.mbox");
    const job = await (await fetch(`${server.url}/api/import`, { method: "POST", headers: { "x-slipstream": "1" }, body: form })).json();
    assert.ok(job.accountId);
    let found: Row[] = [];
    for (let i = 0; i < 50 && found.length === 0; i++) {
      found = (await h(`/api/threads?view=search&q=${encodeURIComponent("archived hello")}`)).body.threads;
      if (!found.length) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(found[0]!.subject, "Archived hello");
    assert.ok(found[0]!.labels.includes("Family"));
    assert.equal((await h(`/api/accounts/${job.accountId}`, { method: "DELETE" })).status, 200);
    assert.equal((await h(`/api/threads?view=search&q=${encodeURIComponent("archived hello")}`)).body.threads.length, 0);
  });
});

describe("team mode", () => {
  let team: Server;
  before(async () => {
    team = await startServer({ mode: "team" });
  });
  after(async () => team.stop());

  test("setup, invite, join, shared conversations and comments", async () => {
    const anon = human(team.url);
    assert.equal((await anon("/api/auth/state")).body.needsSetup, true);
    const owner = await fetch(`${team.url}/api/auth/signup`, {
      method: "POST",
      headers: { "x-slipstream": "1", "content-type": "application/json" },
      body: JSON.stringify({ email: "ana@team.test", name: "Ana", password: "a long enough password", workspaceName: "Fernpoint" }),
    });
    const ownerCookie = owner.headers.get("set-cookie")!.split(";")[0]!;
    const a = human(team.url, ownerCookie);
    const invite = (await a("/api/team/invites", { method: "POST", json: {} })).body;
    const token = new URL(invite.url).searchParams.get("invite")!;
    assert.equal((await anon(`/api/auth/invite?token=${token}`)).body.workspace, "Fernpoint");
    const ben = await fetch(`${team.url}/api/auth/signup`, {
      method: "POST",
      headers: { "x-slipstream": "1", "content-type": "application/json" },
      body: JSON.stringify({ email: "ben@team.test", name: "Ben", password: "another long password", invite: token }),
    });
    const b = human(team.url, ben.headers.get("set-cookie")!.split(";")[0]!);
    assert.deepEqual(((await b("/api/team")).body.members as { name: string }[]).map((m) => m.name), ["Ana", "Ben"]);

    // Ana connects nothing in team mode (no demo), so share needs a thread: import one.
    const form = new FormData();
    form.append("file", new Blob(["From x\nFrom: Client <c@client.test>\nTo: ana@team.test\nSubject: Proposal\nMessage-ID: <p1@client.test>\n\nCan you send the proposal?\n"]), "one.mbox");
    await fetch(`${team.url}/api/import`, { method: "POST", headers: { "x-slipstream": "1", cookie: ownerCookie }, body: form });
    let tid = "";
    for (let i = 0; i < 50 && !tid; i++) {
      tid = ((await a(`/api/threads?view=search&q=proposal`)).body.threads as Row[])[0]?.id ?? "";
      if (!tid) await new Promise((r) => setTimeout(r, 50));
    }
    const shared = (await a(`/api/threads/${tid}/share`, { method: "POST" })).body;
    await b(`/api/shared/${shared.id}/comments`, { method: "POST", json: { body: "I'll take this one." } });
    const view = (await a(`/api/shared/${shared.id}`)).body;
    assert.equal(view.comments[0].author.name, "Ben");
    assert.equal(view.messages[0].subject, "Proposal");
    const benId = ((await a("/api/team")).body.members as { id: string; name: string }[]).find((m) => m.name === "Ben")!.id;
    await a(`/api/shared/${shared.id}`, { method: "PATCH", json: { assigneeId: benId, status: "resolved" } });
    assert.equal(((await b("/api/shared?status=resolved")).body.shared as { assignee: { name: string } }[])[0]!.assignee.name, "Ben");
    // Ben can't see Ana's mail itself.
    assert.equal((await b(`/api/threads/${tid}`)).status, 404);
  });
});
