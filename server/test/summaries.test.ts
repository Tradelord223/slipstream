import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import type { ServerEvent } from "../src/events.ts";
import type { AccountRow } from "../src/mail/store.ts";
import type { FullBody, IncomingMessage, MailProvider, SyncPage } from "../src/mail/types.ts";
import { bundleDeliveries } from "../src/mail/signal-jobs.ts";
import { getThreadWithBodies } from "../src/mail/views.ts";
import { DEMO_IDENTITY, DemoProvider } from "../src/providers/demo.ts";
import { shareThread } from "../src/team.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";
import { FetchStub } from "./stub.ts";

/**
 * Summaries first: mail arrives as headers and a preview, and its full text is fetched when someone (or something that
 * reads whole messages) needs it. These tests drive the store, the sync engine and the routes with a scripted provider.
 */

const envs: TestEnv[] = [];
const fresh = (over: Parameters<typeof makeEnv>[0] = {}) => {
  const e = makeEnv(over);
  envs.push(e);
  return e;
};
let stub: FetchStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
  for (const e of envs.splice(0)) e.cleanup();
});

const bank = { name: "Quarrystone Bank", email: "no-reply@quarrystone.test" };
const ana = { name: "Ana Okoye", email: "ana@fernpoint.test" };

/** A message as the summaries-first sync hands it over: a preview only. */
const summary = (partial: Partial<IncomingMessage> & { from: IncomingMessage["from"] }): IncomingMessage => msg({ bodyComplete: false, ...partial });

interface Rig {
  env: TestEnv;
  accountId: string;
  account: AccountRow;
  /** Remote ids asked for, in order. */
  fetched: string[];
  /** What the provider returns for a remote id; a thrown error is a message it can't return. */
  bodies: Map<string, FullBody | Error>;
  attachmentCalls: [string, string][];
  gate?: Promise<void>;
}

function rig(over: Parameters<typeof makeEnv>[0] = {}): Rig {
  const env = fresh(over);
  const accountId = addAccount(env.ctx, LOCAL_USER_ID, "me@fernpoint.test", "imap");
  const r: Rig = {
    env,
    accountId,
    account: env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId)!,
    fetched: [],
    bodies: new Map(),
    attachmentCalls: [],
  };
  const provider = {
    kind: "imap",
    sync: async () => ({ messages: [], cursor: null, done: true }),
    apply: async () => {},
    fetchBody: async (remoteId: string) => {
      r.fetched.push(remoteId);
      await r.gate;
      const body = r.bodies.get(remoteId);
      if (!body) throw new Error("The message is no longer in that mailbox");
      if (body instanceof Error) throw body;
      return body;
    },
    fetchAttachment: async (messageRemoteId: string, handle: string) => {
      r.attachmentCalls.push([messageRemoteId, handle]);
      return Buffer.from("PDF-BYTES");
    },
  } as unknown as MailProvider;
  env.ctx.sync.provider = () => provider;
  return r;
}

const without = <T extends object>(o: T, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const row = <T,>(env: TestEnv, sql: string, ...p: (string | number)[]) => env.ctx.db.get<T>(sql, ...p)!;
const idOf = (env: TestEnv, remote: string) => row<{ id: string }>(env, "SELECT id FROM messages WHERE remote_id = ?", remote).id;
const threadOf = (env: TestEnv, remote: string) => row<{ thread_id: string }>(env, "SELECT thread_id FROM messages WHERE remote_id = ?", remote).thread_id;
const search = async (env: TestEnv, q: string) =>
  ((await (await env.api(`/api/threads?view=search&q=${encodeURIComponent(q)}`)).json()) as { threads: { id: string }[] }).threads.map((t) => t.id);

describe("a message synced as a summary", () => {
  test("is stored with its preview, size and no html, and a complete message stays cached", () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [
        summary({ remoteId: "s1", from: bank, remoteThreadId: "t1", subject: "Your statement", bodyText: "Your statement is ready to view", size: 48_000 }),
        msg({ remoteId: "c1", from: ana, remoteThreadId: "t2", bodyText: "Locally sent or imported: whole" }),
      ],
      cursor: null,
      done: true,
    });
    const s1 = row<Record<string, unknown>>(r.env, "SELECT body_state, body_text, body_html, snippet, size FROM messages WHERE remote_id = 's1'");
    assert.deepEqual({ ...s1 }, { body_state: "none", body_text: "Your statement is ready to view", body_html: null, snippet: "Your statement is ready to view", size: 48_000 });
    const c1 = row<Record<string, unknown>>(r.env, "SELECT body_state, size FROM messages WHERE remote_id = 'c1'");
    assert.deepEqual({ ...c1 }, { body_state: "cached", size: null });
    // Search finds a summary by what it has: subject, sender, recipients and the preview.
    return Promise.all([search(r.env, "statement"), search(r.env, "quarrystone")]).then(([bySubject, bySender]) => {
      assert.equal(bySubject.length, 1);
      assert.equal(bySender.length, 1);
    });
  });

  test("attachBody swaps in the full text, re-indexes it and finds the code the preview didn't show", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [summary({ remoteId: "s1", from: bank, remoteThreadId: "t1", subject: "Your sign-in code", bodyText: "Use the code below to sign in to your account. It" })],
      cursor: null,
      done: true,
    });
    const id = idOf(r.env, "s1");
    const tid = threadOf(r.env, "s1");
    assert.deepEqual(await search(r.env, "is:code"), []);
    assert.deepEqual(await search(r.env, "amberline"), []);
    assert.equal(row<{ signal: string | null }>(r.env, "SELECT signal FROM threads WHERE id = ?", tid).signal, null);

    const full = "Use the code below to sign in to your account. It expires soon.\n\nYour verification code is 482913.\n\nTracked with amberline.";
    assert.equal(r.env.ctx.store.attachBody(id, { text: full, html: `<p>${full}</p>`, attachments: [] }), tid);

    const m = row<Record<string, unknown>>(r.env, "SELECT body_state, body_text, body_html, signals FROM messages WHERE id = ?", id);
    assert.equal(m.body_state, "cached");
    assert.equal(m.body_text, full);
    assert.match(String(m.body_html), /^<p>Use the code/);
    assert.match(String(m.signals), /"kind":"code"/);
    assert.deepEqual(await search(r.env, "is:code"), [tid], "the signal upgraded from nothing to a code");
    assert.deepEqual(await search(r.env, "amberline"), [tid], "the search index has the whole text now");
    assert.match(row<{ signal: string }>(r.env, "SELECT signal FROM threads WHERE id = ?", tid).signal, /"kind":"code"/, "and so does the list row");
    assert.equal(r.env.ctx.store.attachBody(id, { text: "again", attachments: [] }), null, "a message that has its body is left alone");
    assert.equal(row<{ body_text: string }>(r.env, "SELECT body_text FROM messages WHERE id = ?", id).body_text, full);
  });

  test("attachPreview fills in a header-only message: snippet, search index and signals, and never overwrites a body", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [summary({ remoteId: "s1", from: bank, remoteThreadId: "t1", subject: "Sign-in", bodyText: "" })],
      cursor: null,
      done: true,
    });
    const id = idOf(r.env, "s1");
    const tid = threadOf(r.env, "s1");
    assert.equal(row<{ snippet: string }>(r.env, "SELECT snippet FROM messages WHERE id = ?", id).snippet, "", "nothing is invented while there is no preview");
    assert.deepEqual(await search(r.env, "is:code"), []);
    assert.deepEqual(await search(r.env, "amberline"), []);
    const created = row<{ created_at: number }>(r.env, "SELECT created_at FROM messages WHERE id = ?", id).created_at;

    const text = "Your verification code is 482913. Tracked with amberline.";
    assert.equal(r.env.ctx.store.attachPreview(id, text), tid);
    const m = row<Record<string, unknown>>(r.env, "SELECT body_state, body_text, snippet, signals, created_at FROM messages WHERE id = ?", id);
    assert.equal(m.body_state, "none", "still a summary: the full text is fetched on demand");
    assert.equal(m.body_text, text);
    assert.equal(m.snippet, text);
    assert.match(String(m.signals), /"kind":"code"/);
    assert.equal(m.created_at, created, "arrival time is untouched");
    assert.equal(row<{ snippet: string }>(r.env, "SELECT snippet FROM threads WHERE id = ?", tid).snippet, text, "the thread row shows it");
    assert.deepEqual(await search(r.env, "is:code"), [tid]);
    assert.deepEqual(await search(r.env, "amberline"), [tid]);

    assert.equal(r.env.ctx.store.attachPreview(id, "  "), null, "a blank preview changes nothing");
    const full = "The whole message.";
    r.env.ctx.store.attachBody(id, { text: full, attachments: [] });
    assert.equal(r.env.ctx.store.attachPreview(id, "late preview"), null, "the full text wins");
    assert.equal(row<{ body_text: string }>(r.env, "SELECT body_text FROM messages WHERE id = ?", id).body_text, full);
    assert.equal(r.env.ctx.store.attachPreview("msg_gone", "x"), null);
  });

  test("attachBody keeps attachment ids, takes the new handles, saves inline images and drops stale rows", () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [
        summary({
          remoteId: "s1",
          from: ana,
          remoteThreadId: "t1",
          bodyText: "See the plan",
          attachments: [
            { filename: "plan.pdf", mimeType: "application/pdf", size: 90, inline: false, remoteId: "part:2" },
            { filename: "logo.png", mimeType: "image/png", size: 10, inline: true, contentId: "logo@x", remoteId: "part:3" },
            { filename: "ghost.txt", mimeType: "text/plain", size: 1, inline: false, remoteId: "part:4" },
          ],
        }),
      ],
      cursor: null,
      done: true,
    });
    const id = idOf(r.env, "s1");
    const before = r.env.ctx.db.all<{ id: string; filename: string; blob_sha256: string | null }>("SELECT id, filename, blob_sha256 FROM attachments WHERE message_id = ? ORDER BY filename", id);
    assert.deepEqual(before.map((a) => [a.filename, a.blob_sha256]), [["ghost.txt", null], ["logo.png", null], ["plan.pdf", null]]);

    const png = Buffer.from("PNGBYTES");
    r.env.ctx.store.attachBody(id, {
      text: "See the plan",
      html: '<p>See the plan <img src="cid:logo@x"></p>',
      attachments: [
        { filename: "plan.pdf", mimeType: "application/pdf", size: 120, inline: false, remoteId: "idx:1" },
        { filename: "logo.png", mimeType: "image/png", size: png.length, inline: true, contentId: "logo@x", remoteId: "idx:0", content: png },
        { filename: "extra.csv", mimeType: "text/csv", size: 5, inline: false, remoteId: "idx:2" },
      ],
    });
    const after = r.env.ctx.db.all<{ id: string; filename: string; remote_id: string; size: number; blob_sha256: string | null }>(
      "SELECT id, filename, remote_id, size, blob_sha256 FROM attachments WHERE message_id = ? ORDER BY filename",
      id,
    );
    assert.deepEqual(after.map((a) => [a.filename, a.remote_id, a.size]), [["extra.csv", "idx:2", 5], ["logo.png", "idx:0", png.length], ["plan.pdf", "idx:1", 120]]);
    const idOfName = (rows: { id: string; filename: string }[], name: string) => rows.find((a) => a.filename === name)!.id;
    assert.equal(idOfName(after, "plan.pdf"), idOfName(before, "plan.pdf"), "the dashboard's ids still work");
    assert.equal(idOfName(after, "logo.png"), idOfName(before, "logo.png"));
    assert.ok(!after.some((a) => a.filename === "ghost.txt"), "an attachment the full message doesn't have is gone");
    const logo = after.find((a) => a.filename === "logo.png")!;
    assert.ok(r.env.ctx.store.readBlob(logo.blob_sha256!)!.equals(png), "inline images are small and needed to render, so they are kept");
    assert.equal(after.find((a) => a.filename === "plan.pdf")!.blob_sha256, null, "other attachments stay metadata");
  });
});

describe("reading a conversation", () => {
  test("GET /api/threads/:id shows previews for summaries, and marks cached messages as viewed", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [
        msg({ remoteId: "a", from: ana, remoteThreadId: "t1", bodyText: "Whole earlier message", bodyHtml: "<p>Whole earlier message</p>", sentAt: 1000 }),
        summary({ remoteId: "b", from: bank, remoteThreadId: "t1", bodyText: "Only the preview", sentAt: 2000 }),
      ],
      cursor: null,
      done: true,
    });
    const tid = threadOf(r.env, "a");
    const detail = (await (await r.env.api(`/api/threads/${tid}`)).json()) as { messages: { id: string; bodyState: string; text: string; html: string | null }[] };
    assert.deepEqual(detail.messages.map((m) => [m.bodyState, m.text, m.html]), [["cached", "Whole earlier message", "<p>Whole earlier message</p>"], ["none", "Only the preview", null]]);
    assert.deepEqual(r.fetched, [], "opening a conversation fetches nothing by itself");
    const viewed = r.env.ctx.db.all<{ remote_id: string; last_viewed_at: number | null }>("SELECT remote_id, last_viewed_at FROM messages ORDER BY remote_id");
    assert.ok(viewed[0]!.last_viewed_at! > Date.now() - 5000, "a cached message was just read");
    assert.equal(viewed[1]!.last_viewed_at, null, "a preview wasn't");
  });

  test("GET /api/threads/:id/bodies fetches what was asked for, caches it, and reports a message it couldn't get", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [
        summary({ remoteId: "ok", from: ana, remoteThreadId: "t1", bodyText: "preview ok", sentAt: 1000 }),
        summary({ remoteId: "gone", from: ana, remoteThreadId: "t1", bodyText: "preview gone", sentAt: 2000 }),
        summary({ remoteId: "idle", from: ana, remoteThreadId: "t1", bodyText: "preview idle", sentAt: 3000 }),
      ],
      cursor: null,
      done: true,
    });
    r.bodies.set("ok", { text: "The whole text", html: "<p>The whole text</p>", attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 5, inline: false, remoteId: "idx:0" }] });
    r.bodies.set("gone", new Error("The message is no longer in that mailbox"));
    const tid = threadOf(r.env, "ok");
    const ok = idOf(r.env, "ok");
    const gone = idOf(r.env, "gone");

    // Whole text is for a person: an agent token can't reach this route, and gets none of it.
    const { token } = r.env.ctx.agents.create(LOCAL_USER_ID, "Reader", ["read"]);
    const viaToken = await r.env.api(`/api/threads/${tid}/bodies?ids=${ok}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(viaToken.status, 403);
    assert.ok(!(await viaToken.text()).includes("The whole text"));
    assert.deepEqual(r.fetched, [], "and nothing was fetched for it");

    const res = await r.env.api(`/api/threads/${tid}/bodies?ids=${ok},${gone},msg_not_in_this_thread`);
    assert.equal(res.status, 200, "one bad message never fails the request");
    const body = (await res.json()) as { messages: { id: string; text: string; html: string; attachments: { filename: string }[] }[]; failed: { id: string; error: string }[] };
    assert.deepEqual(body.messages.map((m) => [m.id, m.text, m.html, m.attachments.map((a) => a.filename)]), [[ok, "The whole text", "<p>The whole text</p>", ["a.pdf"]]]);
    assert.deepEqual(body.failed.map((f) => f.id).sort(), [gone, "msg_not_in_this_thread"].sort());
    assert.match(body.failed.find((f) => f.id === gone)!.error, /no longer in that mailbox/);
    assert.deepEqual(r.fetched.sort(), ["gone", "ok"], "only what was asked for, and nothing from outside the conversation");

    const state = r.env.ctx.db.all<{ remote_id: string; body_state: string; last_viewed_at: number | null }>("SELECT remote_id, body_state, last_viewed_at FROM messages ORDER BY remote_id");
    assert.deepEqual(state.map((s) => [s.remote_id, s.body_state]), [["gone", "none"], ["idle", "none"], ["ok", "cached"]]);
    assert.ok(state.find((s) => s.remote_id === "ok")!.last_viewed_at! > Date.now() - 5000);
    assert.deepEqual(await search(r.env, "whole"), [tid], "the message is searchable by its full text now");

    // Asking again costs nothing: it is cached.
    r.fetched.length = 0;
    const again = (await (await r.env.api(`/api/threads/${tid}/bodies?ids=${ok}`)).json()) as { messages: { text: string }[] };
    assert.equal(again.messages[0]!.text, "The whole text");
    assert.deepEqual(r.fetched, []);
  });

  test("the bodies route is 404 for a conversation that isn't yours", async () => {
    const r = rig();
    r.env.ctx.db.run("INSERT INTO users (id, email, name, created_at) VALUES ('usr_other', 'o@o.test', 'Other', 0)");
    const other = r.env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(r.env.ctx, "usr_other", "other@fernpoint.test", "imap"))!;
    r.env.ctx.store.ingest(other, { messages: [summary({ remoteId: "theirs", from: ana, remoteThreadId: "o1", bodyText: "private preview" })], cursor: null, done: true });
    r.bodies.set("theirs", { text: "private whole text", attachments: [] });
    const res = await r.env.api(`/api/threads/${threadOf(r.env, "theirs")}/bodies?ids=${idOf(r.env, "theirs")}`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes("private whole text"));
    assert.deepEqual(r.fetched, [], "and nothing was fetched on their behalf");
    assert.equal((await r.env.api("/api/threads/thr_nope/bodies?ids=a")).status, 404);
  });

  test("two readers of the same message share one fetch", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, { messages: [summary({ remoteId: "s1", from: ana, remoteThreadId: "t1", bodyText: "preview" })], cursor: null, done: true });
    r.bodies.set("s1", { text: "whole", attachments: [] });
    let release!: () => void;
    r.gate = new Promise<void>((resolve) => (release = resolve));
    const id = idOf(r.env, "s1");
    const a = r.env.ctx.sync.bodies.load([id]);
    const b = r.env.ctx.sync.bodies.load([id]);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.loaded, rb.loaded], [[id], [id]]);
    assert.deepEqual(r.fetched, ["s1"]);
  });
});

describe("one-time codes in summaries", () => {
  function withCode() {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [summary({ remoteId: "s1", from: bank, remoteThreadId: "t1", subject: "Your sign-in code", bodyText: "Use the code below to sign in. It expires soon." })],
      cursor: null,
      done: true,
    });
    r.bodies.set("s1", { text: "Use the code below to sign in. It expires soon.\n\nYour verification code is 482913.", attachments: [] });
    return r;
  }

  test("/api/messages/:id/code fetches a message that only has a preview", async () => {
    const r = withCode();
    const res = await r.env.api(`/api/messages/${idOf(r.env, "s1")}/code`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { code: "482913" });
    assert.deepEqual(r.fetched, ["s1"]);
  });

  test("/api/threads/:id/code fetches uncached messages before looking, since a code lower down has no signal yet", async () => {
    const r = withCode();
    const res = await r.env.api(`/api/threads/${threadOf(r.env, "s1")}/code`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { code: "482913" });
  });

  test("an agent reads the whole message through a fetch, with the code still masked", async () => {
    const r = withCode();
    const { agent } = r.env.ctx.agents.create(LOCAL_USER_ID, "Reader", ["read"]);
    const asAgent = { kind: "agent" as const, user: r.env.ctx.users.get(LOCAL_USER_ID)!, agent };
    const res = (await r.env.ctx.commands.execute(asAgent, "mail.read", { threadId: threadOf(r.env, "s1") })) as { result: { messages: { text: string; previewOnly?: boolean }[] } };
    assert.deepEqual(r.fetched, ["s1"]);
    const text = res.result.messages[0]!.text;
    assert.match(text, /Your verification code is ••••••/, "the part past the preview came through, masked");
    assert.ok(!JSON.stringify(res).includes("482913"));
    assert.equal(res.result.messages[0]!.previewOnly, undefined);
  });

  test("an agent is told when the provider can't return the message, and never gets a code from elsewhere", async () => {
    const r = withCode();
    r.bodies.set("s1", new Error("Gmail: Requested entity was not found. (404)"));
    const { agent } = r.env.ctx.agents.create(LOCAL_USER_ID, "Reader", ["read"]);
    const asAgent = { kind: "agent" as const, user: r.env.ctx.users.get(LOCAL_USER_ID)!, agent };
    const res = (await r.env.ctx.commands.execute(asAgent, "mail.read", { threadId: threadOf(r.env, "s1") })) as { result: { messages: { text: string; previewOnly?: boolean }[] } };
    assert.equal(res.result.messages[0]!.previewOnly, true);
    assert.match(res.result.messages[0]!.text, /Use the code below/);
  });
});

describe("readers that need whole messages", () => {
  test("getThreadWithBodies fetches every summary in a conversation, and a snapshot carries the whole text", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [
        summary({ remoteId: "a", from: ana, remoteThreadId: "t1", bodyText: "preview a", sentAt: 1000 }),
        summary({ remoteId: "b", from: bank, remoteThreadId: "t1", bodyText: "preview b", sentAt: 2000 }),
      ],
      cursor: null,
      done: true,
    });
    r.bodies.set("a", { text: "whole a", attachments: [] });
    r.bodies.set("b", { text: "whole b, code is 482913. Your verification code is 482913", attachments: [] });
    const tid = threadOf(r.env, "a");
    const t = await getThreadWithBodies(r.env.ctx, LOCAL_USER_ID, tid);
    assert.deepEqual(t.messages.map((m) => [m.bodyState, m.text.slice(0, 7)]), [["cached", "whole a"], ["cached", "whole b"]]);

    // Sharing with a team reads whole messages too; the code is masked.
    r.env.ctx.db.run("UPDATE messages SET body_state = 'none', body_text = 'preview'");
    r.fetched.length = 0;
    r.env.ctx.users.createWorkspace(LOCAL_USER_ID, "Team");
    const shared = await shareThread(r.env.ctx, LOCAL_USER_ID, tid);
    const snap = row<{ snapshot: string }>(r.env, "SELECT snapshot FROM shared_threads WHERE id = ?", shared.id).snapshot;
    assert.match(snap, /whole a/);
    assert.ok(!snap.includes("482913"));
    assert.deepEqual(r.fetched.sort(), ["a", "b"]);
  });

  test("an attachment of a summary loads the message first, then downloads with the full message's handle", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, {
      messages: [
        summary({
          remoteId: "s1",
          from: ana,
          remoteThreadId: "t1",
          bodyText: "preview",
          attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", size: 90, inline: false, remoteId: "part:2" }],
        }),
      ],
      cursor: null,
      done: true,
    });
    r.bodies.set("s1", { text: "whole", attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", size: 90, inline: false, remoteId: "idx:0" }] });
    const attId = row<{ id: string }>(r.env, "SELECT id FROM attachments").id;
    const res = await r.env.api(`/api/attachments/${attId}`);
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "PDF-BYTES");
    assert.deepEqual(r.attachmentCalls, [["s1", "idx:0"]]);

    // A message that can't be loaded says why instead of downloading the wrong thing.
    r.env.ctx.store.ingest(r.account, {
      messages: [summary({ remoteId: "s2", from: ana, remoteThreadId: "t2", bodyText: "preview", attachments: [{ filename: "b.pdf", mimeType: "application/pdf", size: 9, inline: false, remoteId: "part:2" }] })],
      cursor: null,
      done: true,
    });
    const bad = row<{ id: string }>(r.env, "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.remote_id = 's2'").id;
    const failed = await r.env.api(`/api/attachments/${bad}`);
    assert.equal(failed.status, 502);
    assert.match(((await failed.json()) as { error: string }).error, /Couldn't load this message/);
  });

  test("Autopilot's prompt reads the whole message", async () => {
    const r = rig();
    r.env.ctx.store.ingest(r.account, { messages: [summary({ remoteId: "s1", from: ana, remoteThreadId: "t1", subject: "Question", bodyText: "Quick question about" })], cursor: null, done: true });
    r.bodies.set("s1", { text: "Quick question about the lease: can we move the signing to Thursday afternoon?", attachments: [] });
    const t = row<{ id: string; thread_id: string }>(r.env, "SELECT id, thread_id FROM messages WHERE remote_id = 's1'");
    r.env.ctx.db.run("INSERT INTO autopilot_items (id, user_id, thread_id, message_id, stage, created_at) VALUES ('api_s', ?, ?, ?, 'deciding', ?)", LOCAL_USER_ID, t.thread_id, t.id, Date.now());
    const prompt = await r.env.ctx.autopilot.decidePrompt(LOCAL_USER_ID, ["api_s"]);
    assert.match(prompt, /move the signing to Thursday afternoon/);
    assert.deepEqual(r.fetched, ["s1"]);
  });
});

describe("the demo provider", () => {
  test("gives a message back whole from memory", async () => {
    const demo = new DemoProvider({ accountId: "demo", email: DEMO_IDENTITY.email, auth: null, saveAuth() {}, initialSyncDays: 30 });
    const [first] = (await demo.sync(null)).messages;
    const whole = await demo.fetchBody(first!.remoteId);
    assert.deepEqual([whole.text, whole.html, whole.attachments], [first!.bodyText, first!.bodyHtml, first!.attachments]);
    await assert.rejects(demo.fetchBody("nope"), /isn't here/);
  });
});

describe("the sync engine", () => {
  /** A first sync as the providers report it: the inbox page, then pages of history. */
  function script(r: Rig, inbox: number, history: number[], total: number) {
    let sentAt = Date.now() - 10_000_000;
    const make = (n: number, folders: IncomingMessage["folders"], tag: string) =>
      Array.from({ length: n }, (_, i) => {
        sentAt += 1000;
        const remoteId = `${tag}${i}`;
        r.bodies.set(remoteId, { text: `whole ${remoteId}`, attachments: [] });
        return summary({ remoteId, from: ana, remoteThreadId: `th-${remoteId}`, bodyText: `preview ${remoteId}`, sentAt, folders });
      });
    const inboxFolders = { inbox: true, sent: false, trash: false, spam: false };
    const pages: SyncPage[] = [
      { messages: make(inbox, inboxFolders, "in"), cursor: "1", done: false, progress: { stage: "inbox", total: inbox, count: inbox, last: true } },
      ...history.map((n, i): SyncPage => ({
        messages: make(n, { ...inboxFolders, inbox: false }, `h${i}-`),
        cursor: String(i + 2),
        done: i === history.length - 1,
        progress: { stage: "history", total, count: n, last: i === history.length - 1 },
      })),
    ];
    const fake = {
      kind: "imap",
      sync: async () => pages.shift()!,
      fetchBody: async (remoteId: string) => {
        r.fetched.push(remoteId);
        return r.bodies.get(remoteId) as FullBody;
      },
    } as unknown as MailProvider;
    r.env.ctx.sync.provider = () => fake;
  }

  test("reports exact progress in order, opens the inbox first, and caches the newest 50 inbox messages", async () => {
    const r = rig();
    script(r, 60, [40, 40, 20], 100);
    const events: ServerEvent[] = [];
    const readyWhen: (number | null)[] = [];
    r.env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => {
      events.push(e);
      if (e.type === "sync" && e.progress?.stage === "recent") readyWhen.push(row<{ f: number | null }>(r.env, "SELECT first_synced_at AS f FROM accounts WHERE id = ?", r.accountId).f);
    });
    await r.env.ctx.sync.syncAccount(r.accountId);

    const progress = events.flatMap((e) => (e.type === "sync" && e.progress ? [e.progress] : []));
    assert.deepEqual(
      progress.map((p) => p.stage).filter((s, i, all) => all.indexOf(s) === i),
      ["signin", "inbox", "recent", "previews", "history", "done"],
      "stages come in this order, each once",
    );
    assert.deepEqual(progress[0], { stage: "signin", done: 0, total: null });
    assert.deepEqual(without(progress.find((p) => p.stage === "inbox")!, "rate"), { stage: "inbox", done: 60, total: 60 });
    assert.deepEqual(without(progress.find((p) => p.stage === "previews")!, "rate"), { stage: "previews", done: 60, total: 60 }, "this provider's pages carry their previews already");
    for (const stage of ["recent", "history"] as const) {
      const of = progress.filter((p) => p.stage === stage);
      assert.ok(of.every((p, i) => i === 0 || p.done >= of[i - 1]!.done), `${stage} never goes backwards`);
    }
    assert.deepEqual(without(progress.filter((p) => p.stage === "recent").at(-1)!, "rate"), { stage: "recent", done: 50, total: 50 });
    assert.deepEqual(progress.filter((p) => p.stage === "history").map((p) => [p.done, p.total]), [[40, 100], [80, 100], [100, 100]]);
    assert.deepEqual(progress.at(-1), { stage: "done", done: 100, total: 100 });
    assert.ok(readyWhen.every((f) => f !== null) && readyWhen.length > 0, "the account is ready for the inbox as soon as the recent cache starts, before the window is in");

    // The newest 50 inbox messages are whole; the 10 older ones are previews. History isn't fetched in full.
    const state = row<{ cached: number; none: number }>(r.env, "SELECT sum(body_state = 'cached') AS cached, sum(body_state = 'none') AS none FROM messages WHERE in_inbox = 1");
    assert.deepEqual({ ...state }, { cached: 50, none: 10 });
    assert.equal(r.fetched.length, 50);
    const cachedRemote = new Set(r.env.ctx.db.all<{ remote_id: string }>("SELECT remote_id FROM messages WHERE body_state = 'cached'").map((m) => m.remote_id));
    assert.ok([...Array(10).keys()].every((i) => !cachedRemote.has(`in${i}`)), "the oldest ten are the ones left as previews");
    assert.ok([...Array(50).keys()].every((i) => cachedRemote.has(`in${i + 10}`)));
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages WHERE body_state = 'cached' AND remote_id LIKE 'h%'").n, 0);

    // A reloaded dashboard sees where the sync is.
    const boot = (await (await r.env.api("/api/bootstrap")).json()) as { accounts: { progress: unknown }[] };
    assert.deepEqual(boot.accounts[0]!.progress, { stage: "done", done: 100, total: 100 });
    // Every stage that did work says how fast: items per second so far, a positive number, and the client divides what's left by it.
    for (const p of progress) {
      if (p.stage === "signin" || p.stage === "done" || p.stage === "previews" || p.done === 0) assert.equal(p.rate, undefined, `${p.stage} ${p.done}`);
      else assert.ok(typeof p.rate === "number" && Number.isFinite(p.rate) && p.rate > 0, `${p.stage} ${p.done} has a positive rate, got ${p.rate}`);
    }
    assert.ok(row<{ f: number }>(r.env, "SELECT first_synced_at AS f FROM accounts WHERE id = ?", r.accountId).f >= readyWhen[0]!, "and the mark has moved past the window by the time it is in");
  });

  test("the inbox opens on headers; the newest come in full first, and only the rest get a preview pass", async () => {
    const r = rig();
    const inboxFolders = { inbox: true, sent: false, trash: false, spam: false };
    const headersOnly = (remoteId: string, folders = inboxFolders) => summary({ remoteId, from: ana, remoteThreadId: `th-${remoteId}`, bodyText: "", subject: `Re ${remoteId}`, folders });
    const pages: SyncPage[] = [
      { messages: [headersOnly("i0"), headersOnly("i1")], cursor: "1", done: false, previewIds: ["i0", "i1"], progress: { stage: "inbox", total: 2, count: 2, last: true } },
      { messages: [headersOnly("h0", { ...inboxFolders, inbox: false })], cursor: "2", done: true, previewIds: ["h0"], progress: { stage: "history", total: 1, count: 1, last: true } },
    ];
    const order: string[] = [];
    const events: ServerEvent[] = [];
    r.env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => events.push(e));
    const known = (remote: string) => row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages WHERE remote_id = ?", remote).n === 1;
    const fake = {
      kind: "imap",
      sync: async () => pages.shift()!,
      fetchPreviews: async (ids: string[]) => {
        order.push(`previews ${ids.join(",")} (stored: ${ids.filter(known).length} of ${ids.length}, ready: ${row<{ f: number | null }>(r.env, "SELECT first_synced_at AS f FROM accounts WHERE id = ?", r.accountId).f !== null})`);
        return new Map(ids.map((id) => [id, `preview of ${id}`]));
      },
      // i1 can't be fetched in full right now, so it is the one inbox message left needing a preview.
      fetchBody: async (id: string) => {
        order.push(`body ${id} (ready: ${row<{ f: number | null }>(r.env, "SELECT first_synced_at AS f FROM accounts WHERE id = ?", r.accountId).f !== null})`);
        if (id === "i1") throw new Error("busy");
        return { text: `whole ${id}`, attachments: [] };
      },
    } as unknown as MailProvider;
    r.env.ctx.sync.provider = () => fake;
    const warn = console.warn;
    console.warn = () => {};
    try {
      await r.env.ctx.sync.syncAccount(r.accountId);
    } finally {
      console.warn = warn;
    }

    assert.ok(order[0]!.startsWith("body ") && order[0]!.endsWith("(ready: true)"), "the inbox is open before anything else is fetched, and the newest come in full first");
    assert.ok(order.indexOf("previews i1 (stored: 1 of 1, ready: true)") > order.findIndex((o) => o.startsWith("body i1")), "after the full fetch, only what it couldn't fill gets a preview");
    assert.ok(!order.some((o) => o.startsWith("previews i0")), "a message already fetched in full is never asked for a preview");
    assert.ok(order.indexOf("previews h0 (stored: 1 of 1, ready: true)") > order.indexOf("previews i1 (stored: 1 of 1, ready: true)"), "history previews follow, as their own pass");
    assert.equal(row<{ body_text: string }>(r.env, "SELECT body_text FROM messages WHERE remote_id = 'i0'").body_text, "whole i0");
    assert.equal(row<{ snippet: string }>(r.env, "SELECT snippet FROM messages WHERE remote_id = 'i1'").snippet, "preview of i1");

    // The history one stays a preview.
    assert.equal(row<{ body_text: string }>(r.env, "SELECT body_text FROM messages WHERE remote_id = 'h0'").body_text, "preview of h0");
    assert.equal(row<{ snippet: string }>(r.env, "SELECT snippet FROM messages WHERE remote_id = 'h0'").snippet, "preview of h0");
    assert.deepEqual(await search(r.env, "preview of h0"), [threadOf(r.env, "h0")]);
    // The open inbox is told, thread by thread, as previews arrive.
    const touched = events.filter((e) => e.type === "threads").flatMap((e) => (e.type === "threads" ? e.threadIds : []));
    assert.ok(touched.includes(threadOf(r.env, "i0")) && touched.includes(threadOf(r.env, "h0")));

    const progress = events.flatMap((e) => (e.type === "sync" && e.progress ? [e.progress] : []));
    assert.deepEqual(progress.map((p) => p.stage).filter((st, i, all) => all.indexOf(st) === i), ["signin", "inbox", "recent", "previews", "history", "done"]);
    assert.deepEqual(progress.filter((p) => p.stage === "previews").map((p) => [p.done, p.total, p.rate === undefined]), [[0, 1, true], [1, 1, false]]);
    const done = progress.find((p) => p.stage === "previews" && p.done === 1)!;
    assert.ok(done.rate! > 0 && Number.isFinite(done.rate!));
  });

  test("a preview pass that fails leaves the inbox open and the sync going; only a sign-in problem stops it", async () => {
    const r = rig();
    const page = (): SyncPage => ({
      messages: [summary({ remoteId: "i0", from: ana, remoteThreadId: "th-i0", bodyText: "", folders: { inbox: true, sent: false, trash: false, spam: false } })],
      cursor: "1",
      done: true,
      previewIds: ["i0"],
      progress: { stage: "inbox", total: 1, count: 1, last: true },
    });
    let failure: Error = new Error("connection reset");
    // The full fetch can't help here, so the preview pass runs and is the thing that fails.
    const fake = { kind: "imap", sync: async () => page(), fetchPreviews: async () => { throw failure; }, fetchBody: async () => { throw new Error("busy"); } } as unknown as MailProvider;
    r.env.ctx.sync.provider = () => fake;
    const warn = console.warn;
    console.warn = () => {};
    try {
      await r.env.ctx.sync.syncAccount(r.accountId);
      assert.equal(row<{ sync_status: string }>(r.env, "SELECT sync_status FROM accounts WHERE id = ?", r.accountId).sync_status, "idle");
      assert.equal(row<{ body_state: string }>(r.env, "SELECT body_state FROM messages WHERE remote_id = 'i0'").body_state, "none", "it stays a summary and opens on demand later");

      const { ProviderAuthError } = await import("../src/mail/types.ts");
      failure = new ProviderAuthError("sign in again");
      await r.env.ctx.sync.syncAccount(r.accountId);
      assert.equal(row<{ sync_status: string }>(r.env, "SELECT sync_status FROM accounts WHERE id = ?", r.accountId).sync_status, "reauth");
    } finally {
      console.warn = warn;
    }
  });

  test("history stored after the inbox opened is never mistaken for news by delivery tidying", async () => {
    const r = rig();
    const shop = { name: "Saltmarrow Ceramics", email: "orders@saltmarrow.test" };
    const update = (remote: string, text: string, ago: number) =>
      summary({ remoteId: remote, from: shop, remoteThreadId: `th-${remote}`, subject: "Package update", bodyText: text, sentAt: Date.now() - ago });
    const inboxFolders = { inbox: true, sent: false, trash: false, spam: false };
    let tidied = -1;
    const written: SyncPage[] = [
      { messages: [summary({ remoteId: "i0", from: ana, remoteThreadId: "th-i0", bodyText: "hello" })], cursor: "1", done: false, progress: { stage: "inbox", total: 1, count: 1, last: true } },
      {
        messages: [
          update("old", "Your order has shipped. Tracking number: TWP5050505050", 2 * 86_400_000),
          update("new", "Your package is out for delivery. Tracking number: TWP5050505050", 86_400_000),
        ],
        cursor: "2",
        done: false,
        progress: { stage: "history", total: 2, count: 2, last: false },
      },
      { messages: [], cursor: "3", done: true, progress: { stage: "history", total: 2, count: 0, last: true } },
    ];
    const pages = written.map((p): SyncPage => ({ ...p, messages: p.messages.map((m) => ({ ...m, folders: inboxFolders })) }));
    const fake = {
      kind: "imap",
      sync: async () => {
        // The tidier runs on a timer, so it can look in between any two pages.
        if (pages.length === 1) tidied = bundleDeliveries(r.env.ctx, Date.now() + 1);
        return pages.shift()!;
      },
      fetchBody: async () => ({ text: "whole", attachments: [] }),
    } as unknown as MailProvider;
    r.env.ctx.sync.provider = () => fake;
    await r.env.ctx.sync.syncAccount(r.accountId);
    assert.equal(tidied, 0, "the older update stays: it came with the window, not with the news");
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM threads WHERE in_inbox = 1 AND remote_id IN ('th-old', 'th-new')").n, 2);
  });

  test("an estimate that turns out low settles on the real count; a failed cache fetch doesn't fail the sync", async () => {
    const r = rig();
    script(r, 3, [5], 4);
    r.bodies.set("in1", new Error("not now"));
    const events: ServerEvent[] = [];
    r.env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => events.push(e));
    await r.env.ctx.sync.syncAccount(r.accountId);
    const progress = events.flatMap((e) => (e.type === "sync" && e.progress ? [e.progress] : []));
    assert.deepEqual(progress.filter((p) => p.stage === "history").map((p) => without(p, "rate")), [{ stage: "history", done: 5, total: 5 }]);
    assert.equal(row<{ sync_status: string }>(r.env, "SELECT sync_status FROM accounts WHERE id = ?", r.accountId).sync_status, "idle");
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages WHERE body_state = 'none' AND remote_id LIKE 'in%'").n, 1, "the one that failed stays a preview");
  });

  test("new mail on a later round is cached too, quietly", async () => {
    const r = rig();
    r.env.ctx.db.run("UPDATE accounts SET first_synced_at = ? WHERE id = ?", Date.now() - 1000, r.accountId);
    const fresh1 = summary({ remoteId: "fresh", from: ana, remoteThreadId: "tf", bodyText: "preview", sentAt: Date.now() });
    const fake = { kind: "imap", sync: async () => ({ messages: [fresh1], cursor: "9", done: true }), fetchBody: async (id: string) => (r.fetched.push(id), { text: "whole fresh", attachments: [] }) } as unknown as MailProvider;
    r.env.ctx.sync.provider = () => fake;
    const events: ServerEvent[] = [];
    r.env.ctx.events.subscribe([`user:${LOCAL_USER_ID}`], (e) => events.push(e));
    await r.env.ctx.sync.syncAccount(r.accountId);
    assert.equal(row<{ body_state: string }>(r.env, "SELECT body_state FROM messages WHERE remote_id = 'fresh'").body_state, "cached");
    assert.ok(!events.some((e) => e.type === "sync" && e.progress), "a steady-state sync doesn't flash first-sync progress");
  });

  test("the first sync reaches back 30 days", async () => {
    const r = rig();
    stub = new FetchStub();
    stub.on("GET", "https://gmail.googleapis.com/gmail/v1/users/me/profile", { historyId: "1" });
    stub.on("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages", { messages: [] });
    stub.on("GET", "https://gmail.googleapis.com/gmail/v1/users/me/labels", { labels: [] });
    stub.on("GET", "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs", {});
    const id = addAccount(r.env.ctx, LOCAL_USER_ID, "g@fernpoint.test", "gmail");
    r.env.ctx.db.run("UPDATE accounts SET auth_enc = ? WHERE id = ?", r.env.ctx.secrets.seal({ accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 }), id);
    // The engine builds its own provider for a real account.
    const engine = r.env.ctx.sync;
    delete (engine as unknown as { provider?: unknown }).provider;
    await engine.syncAccount(id);
    const queries = stub.callsTo("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages").map((c) => c.url.searchParams.get("q"));
    assert.deepEqual(queries, ["in:inbox newer_than:30d", "newer_than:30d -in:chats"]);
  });
});
