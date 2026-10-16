import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PermanentProviderError, ProviderAuthError, type OutgoingMessage, type RemoteAction, type SyncPage } from "../src/mail/types.ts";
import { GraphProvider } from "../src/providers/graph.ts";
import { empty, FetchStub, json, rawMail, testConfig, testCtx, type Call } from "./stub.ts";

const ROOT = "https://graph.microsoft.com/v1.0";
const ME = `${ROOT}/me`;
const TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

function newProvider(over: Parameters<typeof testCtx>[0] = {}) {
  const ctx = testCtx(over);
  return { ctx, graph: new GraphProvider(ctx, testConfig()) };
}

const body = (c: Call) => JSON.parse(c.body) as Record<string, unknown>;

function msg(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    subject: `Subject ${id}`,
    from: { emailAddress: { name: "Ann", address: "Ann@Example.org" } },
    toRecipients: [{ emailAddress: { name: "Me", address: "me@example.com" } }],
    ccRecipients: [],
    bccRecipients: [],
    replyTo: [],
    receivedDateTime: "2026-10-06T09:00:05Z",
    sentDateTime: "2026-10-06T09:00:00Z",
    isRead: false,
    flag: { flagStatus: "notFlagged" },
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@example.org>`,
    bodyPreview: `Body of ${id}`,
    hasAttachments: false,
    categories: [],
    parentFolderId: "folder",
    ...extra,
  };
}

const delta = (folder: string) => new RegExp(`^${ME}/mailFolders/${folder}/messages/delta$`);

/** Every folder answers with one page and a delta link; individual tests override what they care about. */
function folderRoutes(s: FetchStub, pages: Partial<Record<string, object[]>> = {}) {
  for (const f of ["inbox", "sentitems", "deleteditems", "junkemail"]) {
    s.on("GET", delta(f), { value: pages[f] ?? [], "@odata.deltaLink": `${ME}/mailFolders/${f}/messages/delta?$deltatoken=${f}-1` });
  }
  s.on("GET", delta("archive"), json({ error: { code: "ErrorFolderNotFound", message: "Folder not found" } }, 404));
}

async function syncAll(graph: GraphProvider, cursor: string | null = null): Promise<{ pages: SyncPage[]; cursor: string }> {
  const pages: SyncPage[] = [];
  let c = cursor;
  for (let i = 0; i < 30; i++) {
    const page = await graph.sync(c);
    pages.push(page);
    c = page.cursor;
    if (page.done) return { pages, cursor: c! };
  }
  throw new Error("sync never finished");
}

describe("Graph delta sync", () => {
  it("walks each folder's pages, then settles on delta links", async () => {
    stub = new FetchStub();
    stub.on("GET", delta("inbox"), (call: Call) =>
      call.url.searchParams.get("$skiptoken") === "s2"
        ? json({ value: [msg("m2")], "@odata.deltaLink": `${ME}/mailFolders/inbox/messages/delta?$deltatoken=inbox-1` })
        : json({ value: [msg("m1")], "@odata.nextLink": `${ME}/mailFolders/inbox/messages/delta?$skiptoken=s2` }),
    );
    for (const f of ["sentitems", "deleteditems", "junkemail"]) {
      stub.on("GET", delta(f), { value: [], "@odata.deltaLink": `${ME}/mailFolders/${f}/messages/delta?$deltatoken=${f}-1` });
    }
    stub.on("GET", delta("archive"), json({ error: { code: "ErrorFolderNotFound", message: "Folder not found" } }, 404));
    const { graph } = newProvider();

    const first = await graph.sync(null);
    assert.equal(first.done, false);
    assert.deepEqual(first.messages.map((m) => m.remoteId), ["m1"]);
    const initial = stub.calls[0]!;
    assert.equal(initial.url.searchParams.get("$select")?.includes("conversationId"), true);
    assert.match(initial.url.searchParams.get("$filter") ?? "", /^receivedDateTime ge \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(initial.headers.get("prefer"), 'IdType="ImmutableId", odata.maxpagesize=100');
    // Summaries only: the body is never selected, the preview and the list headers are, and the newest mail comes first.
    const selected = initial.url.searchParams.get("$select")!.split(",");
    assert.ok(!selected.includes("body") && !selected.includes("uniqueBody"));
    assert.ok(selected.includes("bodyPreview") && selected.includes("internetMessageHeaders") && selected.includes("hasAttachments"));
    assert.equal(initial.url.searchParams.get("$orderby"), "receivedDateTime desc");
    assert.deepEqual(first.progress, { stage: "inbox", total: 1, count: 1, last: true }, "the inbox's first page is the inbox stage");
    assert.deepEqual(JSON.parse(first.cursor!).folders.inbox, { link: `${ME}/mailFolders/inbox/messages/delta?$skiptoken=s2`, kind: "next" });

    const second = await graph.sync(first.cursor);
    assert.equal(second.done, false);
    assert.deepEqual(second.messages.map((m) => m.remoteId), ["m2"]);
    // The next link is followed as given: no filter again, same headers.
    const follow = stub.callsTo("GET", delta("inbox"))[1]!;
    assert.equal(follow.url.searchParams.get("$skiptoken"), "s2");
    assert.equal(follow.url.searchParams.has("$filter"), false);
    assert.equal(follow.headers.get("prefer"), 'IdType="ImmutableId", odata.maxpagesize=100');
    assert.equal(JSON.parse(second.cursor!).folders.inbox.kind, "delta");
    assert.deepEqual(second.progress, { stage: "history", total: null, count: 1, last: false }, "no count route here: the total stays unknown");

    const rest = await syncAll(graph, second.cursor);
    assert.equal(rest.pages.at(-1)!.done, true);
    const folders = JSON.parse(rest.cursor).folders;
    assert.deepEqual(Object.keys(folders), ["inbox", "sentitems", "deleteditems", "junkemail", "archive"]);
    assert.deepEqual(folders.inbox, { link: `${ME}/mailFolders/inbox/messages/delta?$deltatoken=inbox-1`, kind: "delta" });
    assert.deepEqual(folders.archive, { missing: true });
    // Archive is asked about once, not on every poll.
    assert.equal(stub.callsTo("GET", delta("archive")).length, 1);
  });

  it("calls a message ours because of the folder it is in, never because of its From header", async () => {
    stub = new FetchStub();
    folderRoutes(stub, {
      inbox: [msg("forged", { from: { emailAddress: { name: "Me", address: "me@example.com" } } })],
      sentitems: [msg("aliased", { from: { emailAddress: { name: "Help", address: "help@example.com" } } })],
    });
    const { graph } = newProvider();
    const all = (await syncAll(graph)).pages.flatMap((p) => p.messages);
    assert.equal(all.find((m) => m.remoteId === "forged")!.outgoing, false, "anyone can put our address in a From");
    assert.equal(all.find((m) => m.remoteId === "aliased")!.outgoing, true, "mail in Sent Items is ours, whatever alias it went out as");
  });

  it("maps a message to the normalized shape", async () => {
    stub = new FetchStub();
    folderRoutes(stub, {
      inbox: [
        msg("m1", {
          flag: { flagStatus: "flagged" },
          isRead: true,
          categories: ["Clients", "Red category"],
          hasAttachments: true,
          replyTo: [{ emailAddress: { name: "Reply", address: "reply@example.org" } }],
          ccRecipients: [{ emailAddress: { name: "Bob", address: "bob@example.org" } }],
          internetMessageHeaders: [
            { name: "Received", value: "from mx.example.org" },
            { name: "From", value: "Ann <ann@example.org>" },
            { name: "In-Reply-To", value: "<m0@example.org>" },
            { name: "References", value: "<m-1@example.org> <m0@example.org>" },
            { name: "List-Unsubscribe", value: "<https://news.example.org/u/1>" },
            { name: "List-Id", value: "<news.example.org>" },
          ],
        }),
      ],
      sentitems: [
        msg("s1", {
          from: { emailAddress: { name: "Me", address: "me@example.com" } },
          bodyPreview: "plain words",
        }),
      ],
      deleteditems: [msg("d1")],
      junkemail: [msg("j1")],
    });
    stub.on("GET", `${ME}/messages/m1/attachments`, {
      value: [
        { id: "att1", name: "plan.pdf", contentType: "application/pdf", size: 1234, isInline: false, contentId: null },
        { id: "att2", name: "logo.png", contentType: "image/png", size: 99, isInline: true, contentId: "logo@x" },
      ],
    });
    const { graph } = newProvider();
    const { pages } = await syncAll(graph);
    const all = pages.flatMap((p) => p.messages);
    const byId = (id: string) => all.find((m) => m.remoteId === id)!;

    const m1 = byId("m1");
    assert.equal(m1.remoteThreadId, "conv-m1");
    assert.equal(m1.messageIdHeader, "<m1@example.org>");
    assert.deepEqual(m1.from, { name: "Ann", email: "ann@example.org" });
    assert.deepEqual(m1.to, [{ name: "Me", email: "me@example.com" }]);
    assert.deepEqual(m1.cc, [{ name: "Bob", email: "bob@example.org" }]);
    assert.equal(m1.replyTo, "reply@example.org");
    assert.equal(m1.subject, "Subject m1");
    assert.equal(m1.sentAt, Date.parse("2026-10-06T09:00:00Z"));
    assert.equal(m1.bodyHtml, undefined);
    assert.equal(m1.bodyText, "Body of m1", "the preview stands in for the body");
    assert.equal(m1.bodyComplete, false);
    assert.equal(m1.snippet, "Body of m1");
    assert.equal(m1.inReplyTo, "<m0@example.org>");
    assert.deepEqual(m1.references, ["<m-1@example.org>", "<m0@example.org>"]);
    assert.equal(m1.listUnsubscribe, "https://news.example.org/u/1");
    assert.equal(m1.bulk, true);
    assert.equal(m1.unread, false);
    assert.equal(m1.starred, true);
    assert.equal(m1.outgoing, false);
    assert.deepEqual(m1.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.deepEqual(m1.labels, [
      { remoteId: "cat:Clients", name: "Clients" },
      { remoteId: "cat:Red category", name: "Red category" },
    ]);
    assert.deepEqual(m1.attachments, [
      { remoteId: "att1", filename: "plan.pdf", mimeType: "application/pdf", size: 1234, contentId: undefined, inline: false },
      { remoteId: "att2", filename: "logo.png", mimeType: "image/png", size: 99, contentId: "logo@x", inline: true },
    ]);
    assert.equal(m1.attachments.some((a) => "content" in a), false);
    const attCall = stub.callsTo("GET", `${ME}/messages/m1/attachments`)[0]!;
    assert.equal(attCall.url.searchParams.get("$select"), "id,name,contentType,size,isInline,contentId");
    assert.equal(attCall.headers.get("prefer"), 'IdType="ImmutableId"');

    const s1 = byId("s1");
    assert.equal(s1.outgoing, true);
    assert.equal(s1.bodyText, "plain words");
    assert.equal(s1.bodyHtml, undefined);
    assert.equal(s1.inReplyTo, undefined, "no list headers came with it");
    assert.deepEqual(s1.folders, { inbox: false, sent: true, trash: false, spam: false });
    assert.equal(byId("d1").folders.trash, true);
    assert.equal(byId("j1").folders.spam, true);
    assert.equal(stub.callsTo("GET", `${ME}/messages/s1/attachments`).length, 0);
  });

  it("counts the window once the inbox page is out, so the history stage has a total", async () => {
    stub = new FetchStub();
    stub.on("GET", delta("inbox"), (call: Call) =>
      call.url.searchParams.get("$skiptoken") === "s2"
        ? json({ value: [msg("m3")], "@odata.deltaLink": `${ME}/mailFolders/inbox/messages/delta?$deltatoken=inbox-1` })
        : json({ value: [msg("m1"), msg("m2")], "@odata.nextLink": `${ME}/mailFolders/inbox/messages/delta?$skiptoken=s2` }),
    );
    for (const f of ["sentitems", "deleteditems", "junkemail"]) {
      stub.on("GET", delta(f), { value: f === "sentitems" ? [msg("s1")] : [], "@odata.deltaLink": `${ME}/mailFolders/${f}/messages/delta?$deltatoken=${f}-1` });
    }
    stub.on("GET", delta("archive"), json({ error: { code: "ErrorFolderNotFound", message: "Folder not found" } }, 404));
    const counts: Record<string, number> = { inbox: 3, sentitems: 1, deleteditems: 0, junkemail: 0 };
    stub.on("GET", new RegExp(`^${ME}/mailFolders/[a-z]+/messages$`), (call: Call) => {
      const folder = call.url.pathname.split("/").at(-2)!;
      assert.equal(call.url.searchParams.get("$count"), "true");
      assert.match(call.url.searchParams.get("$filter") ?? "", /^receivedDateTime ge /);
      return folder in counts ? json({ "@odata.count": counts[folder], value: [] }) : json({ error: { code: "ErrorFolderNotFound", message: "no" } }, 404);
    });
    const { graph } = newProvider();
    const { pages } = await syncAll(graph);
    const stages = pages.flatMap((p) => (p.progress ? [p.progress] : []));
    assert.deepEqual(stages[0], { stage: "inbox", total: 2, count: 2, last: true });
    // Two messages went out as the inbox stage; the other two in the window are the history.
    assert.ok(stages.slice(1).every((p) => p.stage === "history" && p.total === 2));
    assert.equal(stages.slice(1).reduce((n, p) => n + p.count, 0), 2, "the rest of the inbox, then Sent Items; the empty folders count nothing");
    assert.equal(pages.at(-1)!.progress?.last, true);
  });

  it("fetches a whole message, with every attachment listed, when asked", async () => {
    stub = new FetchStub();
    stub.on("GET", `${ME}/messages/m1`, (call: Call) => {
      assert.equal(call.url.searchParams.get("$select"), "body,hasAttachments");
      return json({ id: "m1", body: { contentType: "html", content: '<p>Hi</p><img src="cid:logo@x">' }, hasAttachments: false });
    });
    stub.on("GET", `${ME}/messages/m1/attachments`, { value: [{ id: "att2", name: "logo.png", contentType: "image/png", size: 99, isInline: true, contentId: "logo@x" }] });
    stub.on("GET", `${ME}/messages/m2`, { id: "m2", body: { contentType: "text", content: "plain words" }, hasAttachments: false });
    const { graph } = newProvider();
    const full = await graph.fetchBody("m1");
    assert.equal(full.html, '<p>Hi</p><img src="cid:logo@x">');
    assert.deepEqual(full.attachments.map((a) => [a.remoteId, a.inline, a.contentId]), [["att2", true, "logo@x"]], "an inline-only message has hasAttachments false, but its cid image is listed");
    const plain = await graph.fetchBody("m2");
    assert.deepEqual([plain.text, plain.html, plain.attachments], ["plain words", undefined, []]);
    assert.equal(stub.callsTo("GET", `${ME}/messages/m2/attachments`).length, 0);
  });

  it("polls every delta link once and handles removals", async () => {
    stub = new FetchStub();
    folderRoutes(stub);
    const { graph } = newProvider();
    const { cursor } = await syncAll(graph);

    stub = (stub.restore(), new FetchStub());
    stub.on("GET", delta("inbox"), {
      value: [{ id: "gone-from-inbox", "@removed": { reason: "deleted" } }, msg("m9", { isRead: true })],
      "@odata.deltaLink": `${ME}/mailFolders/inbox/messages/delta?$deltatoken=inbox-2`,
    });
    stub.on("GET", delta("junkemail"), {
      value: [{ id: "not-spam", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink": `${ME}/mailFolders/junkemail/messages/delta?$deltatoken=junkemail-2`,
    });
    stub.on("GET", delta("sentitems"), { value: [], "@odata.deltaLink": `${ME}/mailFolders/sentitems/messages/delta?$deltatoken=sentitems-2` });
    stub.on("GET", delta("deleteditems"), {
      value: [
        { id: "emptied", "@removed": { reason: "deleted" } },
        { id: "restored", "@removed": { reason: "deleted" } },
      ],
      "@odata.deltaLink": `${ME}/mailFolders/deleteditems/messages/delta?$deltatoken=deleteditems-2`,
    });
    stub.on("GET", `${ME}/messages/emptied`, json({ error: { code: "ErrorItemNotFound", message: "not found" } }, 404));
    stub.on("GET", `${ME}/messages/restored`, { id: "restored" });

    const page = await graph.sync(cursor);
    assert.equal(page.done, true);
    assert.deepEqual(page.messages.map((m) => m.remoteId), ["m9"]);
    assert.equal(page.messages[0]!.unread, false);
    assert.deepEqual(page.flagUpdates, [
      { remoteId: "gone-from-inbox", folders: { inbox: false } },
      { remoteId: "restored", folders: { trash: false } },
      { remoteId: "not-spam", folders: { spam: false } },
    ]);
    // Leaving Deleted Items is only a delete when the message no longer exists anywhere.
    assert.deepEqual(page.deletedRemoteIds, ["emptied"]);
    // Delta links resume where they left off, and the archive folder is not asked about again.
    assert.equal(stub.callsTo("GET", delta("inbox"))[0]!.url.searchParams.get("$deltatoken"), "inbox-1");
    assert.equal(stub.callsTo("GET", delta("archive")).length, 0);
    const folders = JSON.parse(page.cursor!).folders;
    assert.equal(folders.inbox.link.endsWith("inbox-2"), true);
    assert.equal(folders.deleteditems.link.endsWith("deleteditems-2"), true);
  });

  it("keeps paging a folder whose delta has more changes", async () => {
    stub = new FetchStub();
    folderRoutes(stub);
    const { graph } = newProvider();
    const { cursor } = await syncAll(graph);

    stub = (stub.restore(), new FetchStub());
    let polled = 0;
    stub.on("GET", delta("inbox"), (call: Call) =>
      call.url.searchParams.get("$skiptoken") === "more"
        ? json({ value: [msg("m2")], "@odata.deltaLink": `${ME}/mailFolders/inbox/messages/delta?$deltatoken=inbox-3` })
        : (polled++, json({ value: [msg("m1")], "@odata.nextLink": `${ME}/mailFolders/inbox/messages/delta?$skiptoken=more` })),
    );
    for (const f of ["sentitems", "deleteditems", "junkemail"]) {
      stub.on("GET", delta(f), { value: [], "@odata.deltaLink": `${ME}/mailFolders/${f}/messages/delta?$deltatoken=${f}-2` });
    }
    const first = await graph.sync(cursor);
    assert.equal(first.done, false);
    assert.equal(JSON.parse(first.cursor!).folders.inbox.kind, "next");
    const second = await graph.sync(first.cursor);
    assert.equal(second.done, true);
    assert.deepEqual(second.messages.map((m) => m.remoteId), ["m2"]);
    assert.equal(polled, 1);
  });

  it("restarts a folder whose delta token expired", async () => {
    stub = new FetchStub();
    folderRoutes(stub);
    const { graph } = newProvider();
    const { cursor } = await syncAll(graph);

    stub = (stub.restore(), new FetchStub());
    stub.on("GET", delta("inbox"), (call: Call) =>
      call.url.searchParams.has("$deltatoken")
        ? json({ error: { code: "syncStateNotFound", message: "expired" } }, 410)
        : json({ value: [msg("m1")], "@odata.deltaLink": `${ME}/mailFolders/inbox/messages/delta?$deltatoken=fresh` }),
    );
    for (const f of ["sentitems", "deleteditems", "junkemail"]) {
      stub.on("GET", delta(f), { value: [], "@odata.deltaLink": `${ME}/mailFolders/${f}/messages/delta?$deltatoken=${f}-2` });
    }
    const first = await graph.sync(cursor);
    assert.equal(first.done, false);
    assert.equal("inbox" in JSON.parse(first.cursor!).folders, false);
    const second = await graph.sync(first.cursor);
    assert.deepEqual(second.messages.map((m) => m.remoteId), ["m1"]);
    assert.equal(JSON.parse(second.cursor!).folders.inbox.kind, "delta");
  });

  it("refreshes the token on a 401 and retries the page", async () => {
    const link = `${ME}/x?$deltatoken=1`;
    stub = new FetchStub()
      .on("POST", TOKEN, { access_token: "tok-2", refresh_token: "ref-2", expires_in: 3600 })
      .on("GET", delta("inbox"), (call: Call) =>
        call.headers.get("authorization") === "Bearer tok-2"
          ? json({ value: [], "@odata.deltaLink": link })
          : json({ error: { code: "InvalidAuthenticationToken", message: "expired" } }, 401),
      )
      .on("GET", /\/mailFolders\/(sentitems|deleteditems|junkemail)\/messages\/delta$/, { value: [], "@odata.deltaLink": link })
      .on("GET", delta("archive"), json({ error: { code: "ErrorFolderNotFound", message: "no" } }, 404));
    const { graph, ctx } = newProvider();
    await syncAll(graph);
    assert.equal(stub.callsTo("POST", TOKEN).length, 1);
    assert.equal((ctx.saved[0] as { refreshToken: string }).refreshToken, "ref-2");
  });

  it("asks for a new sign-in when the refresh token is rejected", async () => {
    stub = new FetchStub().on("POST", TOKEN, json({ error: "invalid_grant" }, 400));
    const { graph } = newProvider({ auth: { accessToken: "old", refreshToken: "ref-1", expiresAt: 0 } });
    await assert.rejects(graph.sync(null), ProviderAuthError);
  });
});

function ids(...list: string[]): { remoteId: string }[] {
  return list.map((remoteId) => ({ remoteId }));
}

function act(kind: RemoteAction["kind"], messages: string[], extra: object = {}): RemoteAction {
  return { kind, threadRemoteId: "conv-1", messages: ids(...messages), ...extra } as RemoteAction;
}

const BATCH = `${ROOT}/$batch`;

describe("Graph actions", () => {
  it("moves a single message directly", async () => {
    stub = new FetchStub().on("POST", `${ME}/messages/m1/move`, { id: "m1" });
    const { graph } = newProvider();
    await graph.apply(act("archive", ["m1"]));
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(body(stub.calls[0]!), { destinationId: "archive" });
    assert.equal(stub.calls[0]!.headers.get("prefer"), 'IdType="ImmutableId"');
    assert.equal(stub.calls[0]!.headers.get("content-type"), "application/json");
  });

  it("maps each triage action to its destination folder or property", async () => {
    stub = new FetchStub().on("POST", /\/move$/, {}).on("PATCH", /\/messages\/m1$/, {});
    const { graph } = newProvider();
    for (const kind of ["archive", "unarchive", "trash", "untrash", "spam", "unspam"] as const) await graph.apply(act(kind, ["m1"]));
    assert.deepEqual(stub.calls.map((c) => body(c).destinationId), ["archive", "inbox", "deleteditems", "inbox", "junkemail", "inbox"]);
    stub.calls.length = 0;
    for (const kind of ["markRead", "markUnread", "star", "unstar"] as const) await graph.apply(act(kind, ["m1"]));
    assert.deepEqual(stub.calls.map(body), [
      { isRead: true },
      { isRead: false },
      { flag: { flagStatus: "flagged" } },
      { flag: { flagStatus: "notFlagged" } },
    ]);
  });

  it("batches several messages and skips provisional ids", async () => {
    stub = new FetchStub().on("POST", BATCH, (call: Call) => {
      const { requests } = body(call) as { requests: { id: string }[] };
      return json({ responses: requests.map((r) => ({ id: r.id, status: 200, body: {} })) });
    });
    const { graph } = newProvider();
    await graph.apply(act("archive", ["m1", "sent:<x@y>", "m2", "m3"]));
    assert.equal(stub.calls.length, 1);
    const { requests } = body(stub.calls[0]!) as { requests: Record<string, unknown>[] };
    assert.deepEqual(
      requests.map((r) => [r.method, r.url]),
      [
        ["POST", "/me/messages/m1/move"],
        ["POST", "/me/messages/m2/move"],
        ["POST", "/me/messages/m3/move"],
      ],
    );
    assert.deepEqual(requests[0]!.body, { destinationId: "archive" });
    assert.deepEqual(requests[0]!.headers, { Prefer: 'IdType="ImmutableId"', "Content-Type": "application/json" });
  });

  it("splits batches at 20 requests", async () => {
    stub = new FetchStub().on("POST", BATCH, (call: Call) => {
      const { requests } = body(call) as { requests: { id: string }[] };
      return json({ responses: requests.map((r) => ({ id: r.id, status: 200 })) });
    });
    const { graph } = newProvider();
    await graph.apply(act("markRead", Array.from({ length: 45 }, (_, i) => `m${i}`)));
    assert.deepEqual(stub.calls.map((c) => (body(c).requests as unknown[]).length), [20, 20, 5]);
  });

  it("checks each result inside a batch", async () => {
    const respond = (statuses: number[]) => (call: Call) => {
      const { requests } = body(call) as { requests: { id: string }[] };
      return json({ responses: requests.map((r, i) => ({ id: r.id, status: statuses[i], body: statuses[i]! >= 400 ? { error: { code: "x", message: "nope" } } : {} })) });
    };
    const { graph } = newProvider();

    // A message deleted meanwhile doesn't fail the rest.
    stub = new FetchStub().on("POST", BATCH, respond([200, 404, 200]));
    await graph.apply(act("trash", ["m1", "m2", "m3"]));
    stub.restore();

    // Nothing left to act on: retrying can't help.
    stub = new FetchStub().on("POST", BATCH, respond([404, 404]));
    await assert.rejects(graph.apply(act("trash", ["m1", "m2"])), PermanentProviderError);
    stub.restore();

    // Throttling inside a 200 batch is retryable.
    stub = new FetchStub().on("POST", BATCH, respond([200, 429]));
    await assert.rejects(graph.apply(act("trash", ["m1", "m2"])), (err: Error) => !(err instanceof PermanentProviderError) && /429/.test(err.message));
  });

  it("adds a category only where it is missing, reading the current ones first", async () => {
    stub = new FetchStub()
      .on("POST", BATCH, (call: Call) => {
        const { requests } = body(call) as { requests: { id: string; url: string }[] };
        return json({
          responses: requests.map((r) => ({ id: r.id, status: 200, body: { categories: r.url.includes("/m1?") ? ["Clients"] : ["Clients", "Taxes"] } })),
        });
      })
      .on("PATCH", `${ME}/messages/m1`, {});
    const { graph } = newProvider();
    await graph.apply(act("addLabel", ["m1", "m2"], { label: { remoteId: "name:Taxes", name: "Taxes" } }));
    const reads = (body(stub.calls[0]!).requests as { method: string; url: string }[]).map((r) => [r.method, r.url]);
    assert.deepEqual(reads, [
      ["GET", "/me/messages/m1?$select=categories"],
      ["GET", "/me/messages/m2?$select=categories"],
    ]);
    // m2 already has the category, so only m1 is written.
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(body(stub.calls[1]!), { categories: ["Clients", "Taxes"] });
  });

  it("removes a category from a single message", async () => {
    stub = new FetchStub()
      .on("GET", `${ME}/messages/m3`, { categories: ["Clients", "Taxes"] })
      .on("PATCH", `${ME}/messages/m3`, {});
    const { graph } = newProvider();
    await graph.apply(act("removeLabel", ["m3"], { label: { remoteId: "cat:taxes", name: "taxes" } }));
    assert.deepEqual(body(stub.callsTo("PATCH", `${ME}/messages/m3`)[0]!), { categories: ["Clients"] });
  });

  it("sends the MIME message base64-encoded as text/plain", async () => {
    stub = new FetchStub().on("POST", `${ME}/sendMail`, empty(202));
    const { graph } = newProvider();
    const raw = Buffer.from("From: me@example.com\r\nTo: ann@example.org\r\nBcc: hidden@example.net\r\nSubject: Hi\r\n\r\nHello\r\n");
    const message: OutgoingMessage = {
      from: { name: "", email: "me@example.com" },
      to: [{ name: "", email: "ann@example.org" }],
      cc: [],
      bcc: [{ name: "", email: "hidden@example.net" }],
      subject: "Hi",
      html: "<p>Hello</p>",
      text: "Hello",
      raw,
      messageIdHeader: "<out@x>",
    };
    const result = await graph.apply({ kind: "send", message });
    assert.deepEqual(result, {});
    const call = stub.calls[0]!;
    assert.equal(call.headers.get("content-type"), "text/plain");
    assert.equal(call.body, raw.toString("base64"));
    assert.equal(Buffer.from(call.body, "base64").toString().includes("Bcc: hidden@example.net"), true);
  });

  it("surfaces a send failure", async () => {
    stub = new FetchStub().on("POST", `${ME}/sendMail`, json({ error: { code: "ErrorInvalidRecipients", message: "bad recipient" } }, 400));
    const { graph } = newProvider();
    await assert.rejects(graph.apply({ kind: "send", message: { ...({} as OutgoingMessage), raw: rawMail() } }), /bad recipient/);
  });

  it("downloads attachment bytes", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    stub = new FetchStub().on("GET", `${ME}/messages/m1/attachments/att1/$value`, () => new Response(bytes, { status: 200 }));
    const { graph } = newProvider();
    const out = await graph.fetchAttachment("m1", "att1");
    assert.deepEqual(out, bytes);
  });
});
