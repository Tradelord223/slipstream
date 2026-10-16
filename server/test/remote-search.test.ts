import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import type { Actor } from "../src/commands/registry.ts";
import { gmailQuery, graphSearch, imapGmailSearch, imapSearch, planRemote } from "../src/mail/remote-query.ts";
import { searchRemote } from "../src/mail/remote-search.ts";
import type { AccountRow } from "../src/mail/store.ts";
import type { FullBody, IncomingMessage, MailProvider, ProviderQuery } from "../src/mail/types.ts";
import { GmailProvider } from "../src/providers/gmail.ts";
import { GraphProvider } from "../src/providers/graph.ts";
import { ImapProvider, type ImapSettings } from "../src/providers/imap.ts";
import { FakeServer } from "./fake-imap.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";
import { FetchStub, json, testConfig, testCtx, type Call } from "./stub.ts";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const DAY = 86_400_000;
const plan = (q: string) => planRemote(q, NOW);
const sent = (q: string) => plan(q).query!;

/* ------------------------------------------------------------------ translation */

describe("a search is split into what a provider runs and what stays here", () => {
  it("sends free words, from:, to:, subject:, has:attachment and dates", () => {
    const p = plan('invoice from:ana@fernpoint.test to:@quarrystone.test subject:"q3 plan" has:attachment after:2026-01-31 before:2026-03-01');
    assert.deepEqual(p.localOnly, []);
    assert.deepEqual(
      p.query!.clauses.map((c) => c.map((t) => t.kind)),
      [["text"], ["from"], ["to"], ["subject"], ["attachment"], ["after"], ["before"]],
    );
  });

  it("turns newer: and older: into absolute dates", () => {
    const q = sent("newer:7d older:2w");
    assert.deepEqual(q.clauses, [
      [{ kind: "after", at: NOW - 7 * DAY, neg: false }],
      [{ kind: "before", at: NOW - 14 * DAY, neg: false }],
    ]);
  });

  it("keeps operators that only exist here out of what is sent, and lists them", () => {
    const p = plan("invoice is:code label:work category:news -in:trash cc:ana filename:plan.pdf has:reply");
    assert.deepEqual(p.localOnly, ["is:code", "label:work", "category:news", "-in:trash", "cc:ana", "filename:plan.pdf", "has:reply"]);
    assert.deepEqual(p.query!.clauses, [[{ kind: "text", value: "invoice", neg: false }]]);
    assert.equal(p.local.length, 7);
  });

  it("sends nothing when every operator is local", () => {
    const p = plan("is:unread label:work");
    assert.equal(p.query, null);
    assert.deepEqual(p.localOnly, ["is:unread", "label:work"]);
  });

  it("keeps a whole OR group here when one side can't be sent", () => {
    const p = plan("from:ana OR is:unread invoice");
    assert.deepEqual(p.localOnly, ["is:unread"]);
    assert.equal(p.local.length, 1);
    assert.deepEqual(p.query!.clauses, [[{ kind: "text", value: "invoice", neg: false }]]);
  });

  it("reads account: as which accounts to ask, not as something to send", () => {
    const p = plan("account:Me@Fernpoint.test invoice");
    assert.deepEqual(p.accounts, ["me@fernpoint.test"]);
    assert.deepEqual(p.localOnly, []);
    assert.equal(p.query!.clauses.length, 1);
  });

  it("notes whether the search matches message text", () => {
    assert.equal(plan("from:ana").hasText, false);
    assert.equal(plan("from:ana invoice").hasText, true);
    assert.equal(plan("-subject:plan").hasText, true);
  });
});

describe("the query for each provider", () => {
  const q = sent('invoice "q3 plan" from:ana@fernpoint.test -to:bob subject:"team lunch" has:attachment after:2026-01-31 before:2026-03-01');

  it("Gmail: its own operators, dates as epoch seconds", () => {
    assert.equal(
      gmailQuery(q),
      `invoice "q3 plan" from:ana@fernpoint.test -to:bob subject:"team lunch" has:attachment after:${Math.floor(new Date(2026, 0, 31).getTime() / 1000)} before:${Math.floor(new Date(2026, 2, 1).getTime() / 1000)}`,
    );
  });

  it("Gmail: OR groups, negated words, reserved words and quotes", () => {
    assert.equal(gmailQuery(sent("from:ana OR from:bob")), "(from:ana OR from:bob)");
    assert.equal(gmailQuery(sent('-invoice OR "a b"')), '(-invoice OR "a b")');
    assert.equal(gmailQuery(sent('"OR"')), '"OR"');
    assert.equal(gmailQuery(sent("AROUND")), '"AROUND"');
    assert.equal(gmailQuery(sent("foo:bar")), '"foo:bar"');
    assert.equal(gmailQuery(sent('subject:it"s')), 'subject:"it s"', "a stray quote can't break out of the query");
  });

  it("Gmail: weeks and hours become a date, not Gmail's own units", () => {
    assert.equal(gmailQuery(sent("newer:2w")), `after:${Math.floor((NOW - 14 * DAY) / 1000)}`);
    assert.equal(gmailQuery(sent("older:36h")), `before:${Math.floor((NOW - 36 * 3_600_000) / 1000)}`);
  });

  it("Graph: KQL with AND between clauses, NOT, parentheses and day-wide dates", () => {
    assert.equal(
      graphSearch(q),
      'invoice AND "q3 plan" AND from:ana@fernpoint.test AND NOT to:bob AND subject:"team lunch" AND hasAttachments:true AND received>=2026-01-31 AND received<2026-03-01',
    );
    assert.equal(graphSearch(sent("from:ana OR from:bob")), "(from:ana OR from:bob)");
  });

  it("IMAP: SEARCH keys, merged where they don't repeat", () => {
    const keys = imapSearch(sent("invoice from:ana to:bob subject:plan after:2026-01-31"));
    assert.equal(keys.text, "invoice");
    assert.equal(keys.from, "ana");
    assert.equal(keys.to, "bob");
    assert.equal(keys.subject, "plan");
    assert.ok(keys.since instanceof Date);
  });

  it("IMAP: a repeated key, a negation, OR and attachments", () => {
    assert.deepEqual(imapSearch(sent("invoice payroll")), { not: { or: [{ not: { text: "invoice" } }, { not: { text: "payroll" } }] } });
    assert.deepEqual(imapSearch(sent("-from:ana")), { not: { from: "ana" } });
    assert.deepEqual(imapSearch(sent("from:ana OR from:bob")), { or: [{ from: "ana" }, { from: "bob" }] });
    assert.deepEqual(imapSearch(sent("has:attachment")), { header: { "content-type": "multipart/mixed" } });
    assert.deepEqual(imapSearch(sent("before:2026-03-01")), { before: new Date(2026, 2, 1) });
  });

  it("IMAP on Gmail: the Gmail query goes in X-GM-RAW", () => {
    assert.deepEqual(imapGmailSearch(sent("invoice from:ana")), { gmraw: "invoice from:ana" });
  });
});

/* ------------------------------------------------------------------ providers */

let stub: FetchStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const ANA = "Ana Okoye <ana@fernpoint.test>";

describe("Gmail search", () => {
  const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
  const gm = (id: string, subject: string, over: { labels?: string[]; snippet?: string } = {}) => ({
    id,
    threadId: `thread-${id}`,
    labelIds: over.labels ?? ["INBOX"],
    snippet: over.snippet ?? `About ${subject} &amp; more`,
    sizeEstimate: 900,
    internalDate: String(NOW - DAY),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: ANA },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: subject },
        { name: "Date", value: new Date(NOW - DAY).toUTCString() },
        { name: "Message-ID", value: `<${id}@fernpoint.test>` },
      ],
      body: { size: 12 },
    },
  });

  it("lists with the translated query, then fetches field-masked summaries for the hits", async () => {
    stub = new FetchStub();
    stub.on("GET", `${BASE}/messages`, (call: Call) =>
      json(call.url.searchParams.get("pageToken") ? { messages: [{ id: "g3" }] } : { messages: [{ id: "g1" }, { id: "g2" }], nextPageToken: "page-2" }),
    );
    stub.on("GET", new RegExp(`^${BASE}/messages/[^/]+$`), (call: Call) => {
      const id = call.url.pathname.split("/").pop()!;
      return json(gm(id, `Subject ${id}`, { labels: id === "g2" ? ["SENT"] : ["INBOX", "UNREAD"] }));
    });
    const provider = new GmailProvider(testCtx(), testConfig());

    const first = await provider.search(sent("invoice from:ana"), { limit: 2 });
    const list = stub.callsTo("GET", `${BASE}/messages`)[0]!;
    assert.equal(list.url.searchParams.get("q"), "invoice from:ana");
    assert.equal(list.url.searchParams.get("maxResults"), "2");
    assert.equal(list.url.searchParams.get("includeSpamTrash"), null, "spam and trash stay out, as in Gmail");
    for (const call of stub.callsTo("GET", new RegExp(`^${BASE}/messages/[^/]+$`))) {
      assert.equal(call.url.searchParams.get("format"), "full");
      assert.ok(call.url.searchParams.get("fields"), "summaries ask for a field mask, never the message");
    }
    assert.deepEqual(first.messages.map((m) => m.remoteId), ["g1", "g2"]);
    assert.equal(first.next, "page-2");
    const [g1, g2] = first.messages;
    assert.equal(g1!.bodyComplete, false);
    assert.equal(g1!.bodyText, "About Subject g1 & more", "the snippet stands in for the body");
    assert.deepEqual(g1!.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.equal(g1!.unread, true);
    assert.equal(g2!.outgoing, true);

    const second = await provider.search(sent("invoice from:ana"), { limit: 2, pageToken: first.next });
    assert.equal(stub.callsTo("GET", `${BASE}/messages`)[1]!.url.searchParams.get("pageToken"), "page-2");
    assert.deepEqual(second.messages.map((m) => m.remoteId), ["g3"]);
    assert.equal(second.next, undefined);
  });

  it("returns nothing for a search with no hits", async () => {
    stub = new FetchStub();
    stub.on("GET", `${BASE}/messages`, { resultSizeEstimate: 0 });
    const res = await new GmailProvider(testCtx(), testConfig()).search(sent("nothing"), { limit: 10 });
    assert.deepEqual(res, { messages: [], next: undefined });
  });
});

describe("Microsoft Graph search", () => {
  const ROOT = "https://graph.microsoft.com/v1.0";
  const ME = `${ROOT}/me`;
  const folderIds = { inbox: "F-inbox", sentitems: "F-sent", deleteditems: "F-trash", junkemail: "F-junk", drafts: "F-drafts" };
  const hit = (id: string, folder: string, extra: Record<string, unknown> = {}) => ({
    id,
    subject: `Subject ${id}`,
    from: { emailAddress: { name: "Ana", address: "Ana@Fernpoint.test" } },
    toRecipients: [{ emailAddress: { name: "Me", address: "me@example.com" } }],
    receivedDateTime: "2026-10-06T09:00:05Z",
    sentDateTime: "2026-10-06T09:00:00Z",
    isRead: true,
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@fernpoint.test>`,
    bodyPreview: `Preview of ${id}`,
    hasAttachments: false,
    parentFolderId: folder,
    ...extra,
  });
  function graphStub(pages: (call: Call) => object) {
    const s = new FetchStub();
    for (const [name, id] of Object.entries(folderIds)) s.on("GET", `${ME}/mailFolders/${name}`, { id });
    s.on("GET", `${ME}/messages`, (call: Call) => json(pages(call)));
    return s;
  }

  it("asks $search with KQL, without $orderby or $filter, and maps each hit's folder", async () => {
    stub = graphStub(() => ({
      value: [hit("a", folderIds.inbox), hit("b", folderIds.sentitems), hit("c", folderIds.deleteditems), hit("d", "F-somewhere"), hit("e", folderIds.drafts)],
    }));
    const provider = new GraphProvider(testCtx(), testConfig());
    const res = await provider.search(sent('invoice from:ana has:attachment'), { limit: 25 });
    const call = stub.callsTo("GET", `${ME}/messages`)[0]!;
    assert.equal(call.url.searchParams.get("$search"), '"invoice AND from:ana AND hasAttachments:true"');
    assert.equal(call.url.searchParams.get("$top"), "25");
    assert.equal(call.url.searchParams.has("$orderby"), false);
    assert.equal(call.url.searchParams.has("$filter"), false);
    assert.equal(call.headers.get("prefer"), 'IdType="ImmutableId"', "ids match the ones sync stored");
    assert.equal(call.headers.get("consistencylevel"), null, "messages need no ConsistencyLevel header");
    const selected = call.url.searchParams.get("$select")!.split(",");
    assert.ok(selected.includes("bodyPreview") && selected.includes("parentFolderId") && !selected.includes("body"));

    assert.deepEqual(res.messages.map((m) => m.remoteId), ["a", "b", "c", "d"], "drafts are left out");
    const folders = Object.fromEntries(res.messages.map((m) => [m.remoteId, m.folders]));
    assert.deepEqual(folders.a, { inbox: true, sent: false, trash: false, spam: false });
    assert.deepEqual(folders.b, { inbox: false, sent: true, trash: false, spam: false });
    assert.deepEqual(folders.c, { inbox: false, sent: false, trash: true, spam: false });
    assert.deepEqual(folders.d, { inbox: false, sent: false, trash: false, spam: false }, "any other folder reads as archived");
    assert.equal(res.messages[1]!.outgoing, true);
    assert.equal(res.messages[0]!.bodyComplete, false);
    assert.equal(res.messages[0]!.bodyText, "Preview of a");
  });

  it("escapes quotes inside the expression", async () => {
    stub = graphStub(() => ({ value: [] }));
    await new GraphProvider(testCtx(), testConfig()).search(sent('"q3 plan" -subject:"x y"'), { limit: 5 });
    assert.equal(stub.callsTo("GET", `${ME}/messages`)[0]!.url.searchParams.get("$search"), '"\\"q3 plan\\" AND NOT subject:\\"x y\\""');
  });

  it("follows its own next link and refuses any other address", async () => {
    stub = graphStub((call) =>
      call.url.searchParams.get("$skiptoken") === "s2" ? { value: [hit("b", folderIds.inbox)] } : { value: [hit("a", folderIds.inbox)], "@odata.nextLink": `${ME}/messages?$search=%22invoice%22&$skiptoken=s2` },
    );
    const provider = new GraphProvider(testCtx(), testConfig());
    const first = await provider.search(sent("invoice"), { limit: 1 });
    assert.equal(first.next, `${ME}/messages?$search=%22invoice%22&$skiptoken=s2`);
    const second = await provider.search(sent("invoice"), { limit: 1, pageToken: first.next });
    assert.deepEqual(second.messages.map((m) => m.remoteId), ["b"]);
    assert.equal(second.next, undefined);

    const before = stub.calls.length;
    for (const evil of ["https://evil.example/v1.0/me/messages?x=1", `${ROOT}/me/drive/root`, "http://graph.microsoft.com/v1.0/me/messages", "not a url"]) {
      await assert.rejects(provider.search(sent("invoice"), { limit: 1, pageToken: evil }), /can't be continued/);
    }
    assert.equal(stub.calls.length, before, "a refused token sends nothing, and certainly no bearer token");
  });
});

describe("IMAP search", () => {
  const SETTINGS: ImapSettings = { username: "me@example.com", password: "pw", imapHost: "imap.example.com", imapPort: 993, imapSecure: true, smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true };
  const provider = (server: FakeServer) =>
    new ImapProvider({ accountId: "acc1", email: "me@example.com", auth: SETTINGS, saveAuth() {}, initialSyncDays: 30 }, { createClient: () => server.connect().asClient() });
  const mail = (id: string, o: { subject?: string; body?: string; date?: Date; from?: string } = {}) =>
    [
      `Message-ID: <${id}@fernpoint.test>`,
      `From: ${o.from ?? ANA}`,
      "To: me@example.com",
      `Subject: ${o.subject ?? `Subject ${id}`}`,
      `Date: ${(o.date ?? new Date(NOW)).toUTCString()}`,
      "",
      o.body ?? `Body of ${id}`,
      "",
    ].join("\r\n");
  const searches = (s: FakeServer) => s.log.filter((l) => l.startsWith("search "));

  it("searches Inbox, Sent and Archive, and merges the newest hits first", async () => {
    const s = new FakeServer();
    s.add("INBOX", "\\Inbox");
    s.add("Sent", "\\Sent");
    s.add("Archive", "\\Archive");
    s.add("Trash", "\\Trash");
    s.deliver("INBOX", mail("i1", { body: "the quarterly invoice", date: new Date(NOW - 3 * DAY) }));
    s.deliver("Archive", mail("a1", { body: "an old invoice", date: new Date(NOW - 90 * DAY) }));
    s.deliver("Sent", mail("s1", { body: "please see the invoice", date: new Date(NOW - 1 * DAY) }), { flags: ["\\Seen"] });
    s.deliver("INBOX", mail("i2", { body: "lunch on friday", date: new Date(NOW - 2 * DAY) }));
    s.deliver("Trash", mail("t1", { body: "a trashed invoice" }));
    const res = await provider(s).search(sent("invoice"), { limit: 10 });

    assert.deepEqual(res.messages.map((m) => m.messageIdHeader), ["<s1@fernpoint.test>", "<i1@fernpoint.test>", "<a1@fernpoint.test>"]);
    assert.equal(res.next, undefined);
    const none = { inbox: false, sent: false, trash: false, spam: false };
    assert.deepEqual(res.messages.map((m) => m.folders), [{ ...none, sent: true }, { ...none, inbox: true }, none]);
    assert.ok(res.messages.every((m) => m.bodyComplete === false && m.bodyText === ""), "previews come from fetchPreviews");
    assert.deepEqual(searches(s).map((l) => l.split(" ")[1]), ["INBOX", "Sent", "Archive"]);
    assert.ok(searches(s).every((l) => l.includes('"text":"invoice"')));
    assert.equal(s.fullFetches, 0);
  });

  it("brings previews for its hits through fetchPreviews", async () => {
    const s = new FakeServer();
    s.add("INBOX", "\\Inbox");
    s.deliver("INBOX", mail("i1", { body: "the quarterly invoice is attached" }));
    const p = provider(s);
    const { messages } = await p.search(sent("invoice"), { limit: 10 });
    const previews = await p.fetchPreviews(messages.map((m) => m.remoteId));
    assert.equal(previews.get(messages[0]!.remoteId), "the quarterly invoice is attached");
  });

  it("pages by UID, mailbox by mailbox, and ends when every mailbox is spent", async () => {
    const s = new FakeServer();
    s.add("INBOX", "\\Inbox");
    s.add("Sent", "\\Sent");
    for (let i = 1; i <= 4; i++) s.deliver("INBOX", mail(`i${i}`, { body: "invoice", date: new Date(NOW - (10 - i) * DAY) }));
    for (let i = 1; i <= 2; i++) s.deliver("Sent", mail(`s${i}`, { body: "invoice", date: new Date(NOW - (7 - i * 3) * DAY) }));
    const p = provider(s);
    const seen: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 6; page++) {
      const res = await p.search(sent("invoice"), { limit: 2, pageToken: token });
      assert.ok(res.messages.length <= 2);
      seen.push(...res.messages.map((m) => m.messageIdHeader!.slice(1, 3)));
      token = res.next;
      if (!token) break;
    }
    assert.deepEqual(seen, ["s2", "s1", "i4", "i3", "i2", "i1"], "newest first across mailboxes, nothing twice, nothing missed");
    assert.equal(token, undefined);
  });

  it("refuses a token it didn't make", async () => {
    const s = new FakeServer();
    s.add("INBOX", "\\Inbox");
    await assert.rejects(provider(s).search(sent("invoice"), { limit: 5, pageToken: "{\"INBOX\":\"x\"}" }), /can't be continued/);
    await assert.rejects(provider(s).search(sent("invoice"), { limit: 5, pageToken: "nope" }), /can't be continued/);
  });

  it("on Gmail, runs X-GM-RAW in All Mail and nowhere else", async () => {
    const s = new FakeServer({ capabilities: ["IMAP4rev1", "UIDPLUS", "MOVE", "X-GM-EXT-1"], condstore: true });
    s.add("INBOX", "\\Inbox");
    s.add("[Gmail]/All Mail", "\\All");
    s.add("[Gmail]/Trash", "\\Trash");
    s.deliver("[Gmail]/All Mail", mail("g1", { body: "the quarterly invoice" }), { labels: ["\\Inbox", "Clients"], threadId: "77" });
    s.deliver("[Gmail]/All Mail", mail("g2", { body: "lunch" }), { threadId: "78" });
    const res = await provider(s).search(sent("invoice from:ana"), { limit: 10 });
    assert.deepEqual(searches(s), [`search [Gmail]/All Mail {"gmraw":"invoice from:ana"}`]);
    assert.equal(res.messages.length, 1);
    const [m] = res.messages;
    assert.equal(m!.remoteThreadId, "77");
    assert.deepEqual(m!.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.deepEqual(m!.labels, [{ remoteId: "Clients", name: "Clients" }]);
  });
});

/* ------------------------------------------------------------------ merging into the store, the route and the agent command */

const bank = { name: "Quarrystone Bank", email: "no-reply@quarrystone.test" };
const ana = { name: "Ana Okoye", email: "ana@fernpoint.test" };

interface Rig {
  env: TestEnv;
  gmail: string;
  outlook: string;
  asked: { account: string; query: ProviderQuery; pageToken?: string }[];
  /** What each account's provider answers. */
  answers: Record<string, (query: ProviderQuery, opts: { limit: number; pageToken?: string }) => Promise<{ messages: IncomingMessage[]; next?: string }>>;
  bodies: Map<string, FullBody | Error>;
  agent(scopes?: string[]): Actor;
}

const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

function rig(): Rig {
  const env = makeEnv();
  envs.push(env);
  const gmail = addAccount(env.ctx, LOCAL_USER_ID, "me@fernpoint.test", "gmail");
  const outlook = addAccount(env.ctx, LOCAL_USER_ID, "me@quarrystone.test", "outlook");
  const r: Rig = {
    env,
    gmail,
    outlook,
    asked: [],
    answers: { [gmail]: async () => ({ messages: [] }), [outlook]: async () => ({ messages: [] }) },
    bodies: new Map(),
    agent: (scopes = ["read"]) => ({
      kind: "agent",
      user: env.ctx.users.get(LOCAL_USER_ID)!,
      agent: env.ctx.agents.create(LOCAL_USER_ID, "Finder", scopes as never, {} as never).agent,
    }),
  };
  env.ctx.sync.provider = (account: AccountRow) =>
    ({
      kind: account.provider,
      sync: async () => ({ messages: [], cursor: null, done: true }),
      apply: async () => {},
      search: async (query: ProviderQuery, opts: { limit: number; pageToken?: string }) => {
        r.asked.push({ account: account.id, query, pageToken: opts.pageToken });
        return r.answers[account.id]!(query, opts);
      },
      fetchBody: async (remoteId: string) => {
        const b = r.bodies.get(remoteId);
        if (!b) throw new Error("no such message");
        if (b instanceof Error) throw b;
        return b;
      },
    }) as unknown as MailProvider;
  return r;
}

const hitMsg = (over: Partial<IncomingMessage> & { remoteId: string; from: IncomingMessage["from"] }): IncomingMessage =>
  msg({ bodyComplete: false, folders: { inbox: false, sent: false, trash: false, spam: false }, unread: false, sentAt: NOW - 400 * DAY, ...over });
const answer = (messages: IncomingMessage[], next?: string) => async () => ({ messages, next });
const subjects = (res: { threads: { subject: string }[] }) => res.threads.map((t) => t.subject).sort();

describe("search results join the store as ordinary summaries", () => {
  it("stores hits as conversations with only a preview, which open like any other", async () => {
    const r = rig();
    r.answers[r.gmail] = answer([hitMsg({ remoteId: "old1", remoteThreadId: "tOld", from: ana, subject: "Lease renewal", bodyText: "Preview of the lease", sentAt: NOW - 500 * DAY })]);
    const res = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease" });
    assert.deepEqual(res.threads.map((t) => t.subject), ["Lease renewal"]);
    assert.equal(res.threads[0]!.accountId, r.gmail);
    assert.equal(res.threads[0]!.inInbox, false);
    assert.equal(res.next, null);
    assert.deepEqual(res.failures, []);
    assert.deepEqual(res.searched.map((s) => s.accountId), [r.gmail, r.outlook]);

    const stored = r.env.ctx.db.get<{ body_state: string; body_text: string }>("SELECT body_state, body_text FROM messages WHERE remote_id = 'old1'")!;
    assert.deepEqual({ ...stored }, { body_state: "none", body_text: "Preview of the lease" });
    // The same rows the local list returns, and the conversation opens.
    const listed = (await (await r.env.api(`/api/threads?view=search&q=lease`)).json()) as { threads: { id: string }[] };
    assert.deepEqual(listed.threads.map((t) => t.id), [res.threads[0]!.id], "after the search, local search finds it too");
    const opened = await r.env.api(`/api/threads/${res.threads[0]!.id}`);
    assert.equal(opened.status, 200);
    assert.equal(r.env.ctx.db.get<{ cursor: string | null }>("SELECT sync_cursor AS cursor FROM accounts WHERE id = ?", r.gmail)!.cursor, null, "a search never moves a sync cursor");
  });

  it("de-duplicates: the same hit twice is one conversation, and mail already here is left alone", async () => {
    const r = rig();
    const inbox = { inbox: true, sent: false, trash: false, spam: false };
    r.env.ctx.store.ingest(r.env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", r.gmail)!, {
      messages: [msg({ remoteId: "known1", remoteThreadId: "tKnown", from: ana, subject: "Known thread", bodyText: "Already here", folders: inbox })],
      cursor: null,
      done: true,
    });
    const threadId = r.env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = 'tKnown'")!.id;
    // Archived here a moment ago; the provider still says "inbox" because the change hasn't gone out yet.
    r.env.ctx.db.run("UPDATE threads SET in_inbox = 0 WHERE id = ?", threadId);
    r.env.ctx.db.run("UPDATE messages SET in_inbox = 0 WHERE thread_id = ?", threadId);
    const hits = [
      hitMsg({ remoteId: "known1", remoteThreadId: "tKnown", from: ana, subject: "Known thread", folders: inbox }),
      hitMsg({ remoteId: "new1", remoteThreadId: "tNew", from: ana, subject: "Fresh find" }),
      hitMsg({ remoteId: "new1", remoteThreadId: "tNew", from: ana, subject: "Fresh find" }),
    ];
    r.answers[r.gmail] = answer(hits);
    const first = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "thread", account: r.gmail });
    const second = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "thread", account: r.gmail });
    assert.deepEqual(subjects(first), ["Fresh find", "Known thread"]);
    assert.deepEqual(second.threads.map((t) => t.id).sort(), first.threads.map((t) => t.id).sort());
    assert.equal(r.env.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n, 2, "no duplicate messages");
    assert.equal(r.env.ctx.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", threadId)!.in_inbox, 0, "the local archive stands");
  });

  it("hides trash and spam unless the search names them, and applies local-only operators to the hits", async () => {
    const r = rig();
    r.answers[r.gmail] = answer([
      hitMsg({ remoteId: "h1", remoteThreadId: "t1", from: ana, subject: "Plain", unread: true }),
      hitMsg({ remoteId: "h2", remoteThreadId: "t2", from: ana, subject: "Read one", unread: false }),
      hitMsg({ remoteId: "h3", remoteThreadId: "t3", from: ana, subject: "Binned", folders: { inbox: false, sent: false, trash: true, spam: false } }),
    ]);
    assert.deepEqual(subjects(await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "ana", account: r.gmail })), ["Plain", "Read one"]);
    const unread = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "ana is:unread", account: r.gmail });
    assert.deepEqual(subjects(unread), ["Plain"]);
    assert.deepEqual(unread.localOnly, ["is:unread"]);
    assert.match(unread.note!, /Not sent to the mail provider.*is:unread/);
    assert.deepEqual(r.asked.at(-1)!.query.clauses, [[{ kind: "text", value: "ana", neg: false }]], "is:unread was not sent");
    assert.deepEqual(subjects(await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "ana in:trash", account: r.gmail })), ["Binned"]);
  });

  it("doesn't call a provider for a search that has nothing to send", async () => {
    const r = rig();
    const res = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "is:unread label:work" });
    assert.deepEqual(res.threads, []);
    assert.deepEqual(res.localOnly, ["is:unread", "label:work"]);
    assert.equal(r.asked.length, 0);
  });

  it("skips demo and archive accounts, and an account: operator picks the account", async () => {
    const r = rig();
    addAccount(r.env.ctx, LOCAL_USER_ID, "demo@example.test", "demo");
    addAccount(r.env.ctx, LOCAL_USER_ID, "old@example.test", "archive");
    r.answers[r.gmail] = answer([]);
    r.answers[r.outlook] = answer([]);
    const all = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease" });
    assert.deepEqual(all.searched.map((s) => s.provider).sort(), ["gmail", "outlook"]);
    r.asked.length = 0;
    await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease account:me@quarrystone.test" });
    assert.deepEqual(r.asked.map((a) => a.account), [r.outlook]);
    await assert.rejects(searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease", account: "acc_missing" }), /Account not found/);
  });
});

describe("one account failing doesn't fail the search", () => {
  it("returns the other account's hits, names the failure, and asks the failed one again for more", async () => {
    const r = rig();
    r.answers[r.gmail] = answer([hitMsg({ remoteId: "g1", remoteThreadId: "tg", from: ana, subject: "From Gmail" })], "gmail-page-2");
    r.answers[r.outlook] = async () => {
      throw new Error("Microsoft Graph: The mailbox is busy (503)");
    };
    const res = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease" });
    assert.deepEqual(res.threads.map((t) => t.subject), ["From Gmail"]);
    assert.deepEqual(res.failures, [{ accountId: r.outlook, email: "me@quarrystone.test", provider: "outlook", error: "Microsoft Graph: The mailbox is busy (503)" }]);
    assert.ok(res.next);

    r.asked.length = 0;
    r.answers[r.outlook] = answer([hitMsg({ remoteId: "o1", remoteThreadId: "to", from: bank, subject: "From Outlook" })]);
    r.answers[r.gmail] = answer([]);
    const more = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease", pageToken: res.next });
    assert.deepEqual(r.asked.map((a) => [a.account, a.pageToken]).sort(), [[r.gmail, "gmail-page-2"], [r.outlook, undefined]].sort());
    assert.deepEqual(more.threads.map((t) => t.subject), ["From Outlook"]);
    assert.deepEqual(more.failures, []);
    assert.equal(more.next, null);
  });

  it("gives a provider that doesn't answer in time up after the timeout", async () => {
    const r = rig();
    r.answers[r.gmail] = () => new Promise(() => {});
    r.answers[r.outlook] = answer([hitMsg({ remoteId: "o1", remoteThreadId: "to", from: bank, subject: "Quick answer" })]);
    const started = Date.now();
    const res = await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease", timeoutMs: 40 });
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(res.threads.map((t) => t.subject), ["Quick answer"]);
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0]!.accountId, r.gmail);
    assert.match(res.failures[0]!.error, /took too long/);
  });

  it("refuses a page token that isn't one of ours", async () => {
    const r = rig();
    await assert.rejects(searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease", pageToken: "!!!" }), /can't be continued/);
  });
});

describe("the search route", () => {
  it("returns list rows, a token and the failures; and a person only", async () => {
    const r = rig();
    r.answers[r.gmail] = answer([hitMsg({ remoteId: "g1", remoteThreadId: "tg", from: ana, subject: "Lease renewal" })], "more");
    r.answers[r.outlook] = async () => {
      throw new Error("nope");
    };
    const res = (await (await r.env.api("/api/search/remote?q=lease")).json()) as { threads: { subject: string; id: string; sortAt: number }[]; next: string; failures: { accountId: string }[] };
    assert.deepEqual(res.threads.map((t) => t.subject), ["Lease renewal"]);
    assert.equal(typeof res.next, "string");
    assert.equal(res.failures[0]!.accountId, r.outlook);
    const rows = (await (await r.env.api(`/api/threads-by-ids?ids=${res.threads[0]!.id},nothing`)).json()) as { threads: { id: string }[] };
    assert.deepEqual(rows.threads.map((t) => t.id), [res.threads[0]!.id]);

    assert.equal((await r.env.api("/api/search/remote?q=lease&pageToken=%25%25")).status, 400);
    assert.equal((await r.env.api(`/api/search/remote?q=lease&limit=500`)).status, 400, "no more than 50 per account");
    const token = r.env.ctx.agents.create(LOCAL_USER_ID, "Finder", ["read"], {} as never).token;
    const denied = await r.env.api("/api/search/remote?q=lease", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(denied.status, 403, "agents use the command, not this route");
  });

  it("asks each provider for at most 50", async () => {
    const r = rig();
    let limit = 0;
    r.answers[r.gmail] = async (_q, o) => ((limit = o.limit), { messages: [] });
    r.answers[r.outlook] = answer([]);
    await r.env.api("/api/search/remote?q=lease");
    assert.equal(limit, 50);
    await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "lease", limit: 5000 });
    assert.equal(limit, 50);
  });
});

describe("mail.searchAll for an agent", () => {
  const codeBody = (n: string) => ({ text: `Your Quarrystone verification code is ${n}. It expires in 10 minutes.`, attachments: [] });

  async function run(r: Rig, actor: Actor, input: object) {
    const out = await r.env.ctx.commands.execute(actor, "mail.searchAll", input);
    assert.equal(out.status, "done", JSON.stringify(out));
    return (out as unknown as { result: { threads: { id: string; subject: string; snippet: string }[]; failures: unknown[]; localOnly: string[]; note?: string; next: string | null } }).result;
  }

  it("is a read command, listed for read-only agents", async () => {
    const r = rig();
    const found = r.env.ctx.commands.describe({ actor: r.agent(["read"]) }).find((c) => c.name === "mail.searchAll");
    assert.equal(found?.scope, "read");
    assert.equal(found?.readOnly, true);
  });

  it("returns compact rows, the failures and the operators it left out", async () => {
    const r = rig();
    r.answers[r.gmail] = answer([hitMsg({ remoteId: "g1", remoteThreadId: "tg", from: ana, subject: "Lease renewal", bodyText: "Please sign the lease" })]);
    r.answers[r.outlook] = async () => {
      throw new Error("Graph is down");
    };
    r.bodies.set("g1", { text: "Please sign the lease and send it back.", attachments: [] });
    const res = await run(r, r.agent(), { query: "lease is:unread" });
    assert.equal(res.threads.length, 0, "is:unread narrows the hit, which is read");
    const plain = await run(r, r.agent(), { query: "lease" });
    assert.deepEqual(plain.threads.map((t) => t.subject), ["Lease renewal"]);
    assert.ok(!("participants" in plain.threads[0]!), "compact rows");
    assert.deepEqual((plain.failures as { accountId: string }[]).map((f) => f.accountId), [r.outlook]);
    assert.deepEqual(res.localOnly, ["is:unread"]);
    assert.match(res.note!, /is:unread/);
  });

  it("never returns a conversation with a one-time code when the search has words, however deep the code sits", async () => {
    const r = rig();
    // The preview says nothing about a code; the full message does.
    r.answers[r.gmail] = answer([
      hitMsg({ remoteId: "c1", remoteThreadId: "tc", from: bank, subject: "Your statement", bodyText: "Here is your statement for the month" }),
      hitMsg({ remoteId: "p1", remoteThreadId: "tp", from: ana, subject: "Coffee?", bodyText: "Tuesday morning? I'm at 618 Elm Street." }),
    ]);
    r.bodies.set("c1", codeBody("618204"));
    r.bodies.set("p1", { text: "Tuesday morning? I'm at 618 Elm Street.", attachments: [] });
    const asAgent = r.agent();
    for (const q of ["statement 618", "statement 619", "statement"]) {
      const res = await run(r, asAgent, { query: q, detail: "full" });
      assert.ok(!JSON.stringify(res).includes("618204"), `no code in the answer to "${q}"`);
      assert.ok(!res.threads.some((t) => t.subject === "Your statement"), `the code thread stays out of "${q}"`);
    }
    // Plain mail still comes back, and a person still sees everything.
    assert.deepEqual((await run(r, asAgent, { query: "coffee" })).threads.map((t) => t.subject), ["Coffee?"]);
    assert.ok(subjects(await searchRemote(r.env.ctx, LOCAL_USER_ID, { q: "statement" })).includes("Your statement"));
  });

  it("leaves out a conversation it couldn't read in full, since it couldn't check it", async () => {
    const r = rig();
    r.answers[r.gmail] = answer([hitMsg({ remoteId: "u1", remoteThreadId: "tu", from: bank, subject: "Unreadable", bodyText: "Preview only" })]);
    r.bodies.set("u1", new Error("The message is no longer in that mailbox"));
    assert.deepEqual((await run(r, r.agent(), { query: "unreadable" })).threads, []);
  });

  it("masks a code that is in what it may see, when the search has no words", async () => {
    const r = rig();
    r.answers[r.gmail] = answer([
      hitMsg({ remoteId: "c1", remoteThreadId: "tc", from: bank, subject: "Sign-in code 618204", bodyText: "Your verification code is 618204. It expires soon." }),
    ]);
    const res = await run(r, r.agent(), { query: "from:no-reply@quarrystone.test", detail: "full" });
    assert.equal(res.threads.length, 1);
    assert.ok(!JSON.stringify(res).includes("618204"), "masked in the subject and snippet");
  });
});
