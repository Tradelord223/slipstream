import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Db } from "../src/db/index.ts";
import { MailStore, type AccountRow } from "../src/mail/store.ts";
import { PermanentProviderError, ProviderAuthError, type OutgoingMessage, type RemoteAction } from "../src/mail/types.ts";
import { GmailProvider, SUMMARY_FIELDS } from "../src/providers/gmail.ts";
import { parseMime, type MimeNode } from "./mime-fake.ts";
import { FetchStub, json, rawMail, testConfig, testCtx, type Call } from "./stub.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN = "https://oauth2.googleapis.com/token";

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

interface FakeMessage {
  threadId: string;
  labelIds: string[];
  raw: Buffer;
  internalDate?: string;
  snippet?: string;
}

/** The part tree Gmail returns for format=full once the field mask has dropped every byte of body data. */
function payloadOf(node: MimeNode, path: number[] = []): object {
  const type = node.headers.get("content-type") ?? "text/plain";
  const disposition = node.headers.get("content-disposition") ?? "";
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "";
  return {
    partId: path.join("."),
    mimeType: type.split(";")[0]!.trim().toLowerCase(),
    filename,
    headers: node.all.map(([name, value]) => ({ name, value })),
    body: { size: node.body.length, ...(filename ? { attachmentId: `att-${path.join(".")}` } : {}) },
    ...(node.children ? { parts: node.children.map((c, i) => payloadOf(c, [...path, i + 1])) } : {}),
  };
}

function summaryOf(id: string, m: FakeMessage): object {
  const top = parseMime(m.raw);
  const noise = ["Received", "DKIM-Signature", "ARC-Seal", "Authentication-Results"].map((name) => ({ name, value: "x".repeat(300) }));
  return {
    id,
    threadId: m.threadId,
    labelIds: m.labelIds,
    snippet: m.snippet ?? top.body.toString().slice(0, 80).trim(),
    sizeEstimate: m.raw.length,
    internalDate: m.internalDate ?? "1791277200000",
    payload: { ...payloadOf(top), headers: [...noise, ...top.all.map(([name, value]) => ({ name, value }))] },
  };
}

/** Every GET of one message, by format. */
const formats = (s: FetchStub, id: string) => s.callsTo("GET", `${BASE}/messages/${id}`).map((c) => c.url.searchParams.get("format"));

/** A small fake of the Gmail endpoints the provider reads. */
function mailbox(messages: Record<string, FakeMessage>, extra: { labels?: object[] } = {}): FetchStub {
  const s = new FetchStub();
  s.on("GET", `${BASE}/labels`, { labels: extra.labels ?? [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Clients", type: "user" }] });
  s.on("GET", new RegExp(`^${BASE}/messages/[^/]+$`), (call: Call) => {
    const id = call.url.pathname.split("/").pop()!;
    const m = messages[id];
    if (!m) return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
    const format = call.url.searchParams.get("format");
    if (format === "full") {
      assert.equal(call.url.searchParams.get("fields"), SUMMARY_FIELDS, "a summary asks for a field mask, not the whole message");
      return json(summaryOf(id, m));
    }
    return json(
      format === "raw"
        ? { id, threadId: m.threadId, labelIds: m.labelIds, raw: m.raw.toString("base64url"), internalDate: m.internalDate ?? "1791277200000" }
        : { id, threadId: m.threadId, labelIds: m.labelIds },
    );
  });
  return s;
}

const body = (c: Call) => JSON.parse(c.body) as Record<string, unknown>;

function newProvider(over: Parameters<typeof testCtx>[0] = {}) {
  const ctx = testCtx(over);
  return { ctx, gmail: new GmailProvider(ctx, testConfig()) };
}

describe("Gmail ownership", () => {
  it("calls a message ours because of the SENT label, never because of its From header", async () => {
    const mail: Record<string, FakeMessage> = {
      forged: { threadId: "t1", labelIds: ["INBOX"], raw: rawMail({ from: "me@example.com", subject: "Forged", messageId: "<forged@x>" }) },
      aliased: { threadId: "t2", labelIds: ["SENT"], raw: rawMail({ from: "help@example.com", to: "ann@example.org", subject: "From an alias", messageId: "<aliased@x>" }) },
    };
    stub = mailbox(mail);
    stub.on("GET", `${BASE}/profile`, { emailAddress: "me@example.com", historyId: "100" });
    stub.on("GET", `${BASE}/messages`, { messages: [{ id: "forged", threadId: "t1" }, { id: "aliased", threadId: "t2" }] });
    const { gmail } = newProvider();
    const page = await gmail.sync(null);
    assert.equal(page.messages.find((m) => m.remoteId === "forged")!.outgoing, false);
    assert.equal(page.messages.find((m) => m.remoteId === "aliased")!.outgoing, true);
  });
});

describe("Gmail initial sync", () => {
  const sevenMessages = (): Record<string, FakeMessage> => ({
    m1: { threadId: "t1", labelIds: ["INBOX", "UNREAD", "Label_1", "CATEGORY_UPDATES", "IMPORTANT"], raw: rawMail({ subject: "Quarterly plan", messageId: "<m1@x>", body: "Numbers inside &amp; more" }), snippet: "It&#39;s the plan &amp; the numbers" },
    m2: { threadId: "t1", labelIds: ["SENT"], raw: rawMail({ from: "me@example.com", to: "ann@example.org", subject: "Re: Quarterly plan", messageId: "<m2@x>", inReplyTo: "<m1@x>" }) },
    m3: { threadId: "t2", labelIds: ["TRASH", "STARRED"], raw: rawMail({ subject: "Old", messageId: "<m3@x>" }) },
    m4: { threadId: "t3", labelIds: ["SPAM"], raw: rawMail({ subject: "Win big", messageId: "<m4@x>" }) },
    m5: { threadId: "t4", labelIds: ["DRAFT"], raw: rawMail({ subject: "Unsent", messageId: "<m5@x>" }) },
    m6: { threadId: "t5", labelIds: ["CHAT"], raw: rawMail({ subject: "chat", messageId: "<m6@x>" }) },
    m7: { threadId: "t6", labelIds: [], raw: rawMail({ subject: "Archived", messageId: "<m7@x>" }) },
  });

  /** Lists the way Gmail does: the inbox query returns inbox mail, the window query pages through everything. */
  function listing(mail: Record<string, FakeMessage>) {
    stub = mailbox(mail);
    stub.on("GET", `${BASE}/profile`, { emailAddress: "me@example.com", historyId: "100" });
    stub.on("GET", `${BASE}/messages`, (call: Call) => {
      const q = call.url.searchParams.get("q") ?? "";
      if (q.startsWith("in:inbox")) return json({ messages: Object.entries(mail).filter(([, m]) => m.labelIds.includes("INBOX")).map(([id, m]) => ({ id, threadId: m.threadId })) });
      return call.url.searchParams.get("pageToken") === "p2"
        ? json({ messages: [{ id: "m5", threadId: "t4" }, { id: "m6", threadId: "t5" }, { id: "m7", threadId: "t6" }], resultSizeEstimate: 99 })
        : json({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t1" }, { id: "m3", threadId: "t2" }, { id: "m4", threadId: "t3" }], nextPageToken: "p2", resultSizeEstimate: 7 });
    });
  }

  it("opens with the newest inbox mail, then pages through the window, and ends on an incremental cursor", async () => {
    listing(sevenMessages());
    const { gmail } = newProvider();

    const inbox = await gmail.sync(null);
    assert.equal(inbox.done, false);
    assert.deepEqual(inbox.messages.map((m) => m.remoteId), ["m1"]);
    assert.deepEqual(inbox.progress, { stage: "inbox", total: 1, count: 1, last: true });
    assert.deepEqual(JSON.parse(inbox.cursor!), { phase: "initial", historyId: "100", top: true });
    const inboxList = stub!.callsTo("GET", `${BASE}/messages`)[0]!.url.searchParams;
    assert.equal(inboxList.get("q"), "in:inbox newer_than:120d");
    assert.equal(inboxList.get("maxResults"), "100");

    const first = await gmail.sync(inbox.cursor);
    assert.equal(first.done, false);
    assert.deepEqual(JSON.parse(first.cursor!), { phase: "initial", historyId: "100", top: true, pageToken: "p2", total: 7 });
    assert.deepEqual(first.messages.map((m) => m.remoteId), ["m2", "m3", "m4"], "m1 came with the inbox page");
    assert.deepEqual(first.progress, { stage: "history", total: 7, count: 4, last: false });
    const list = stub!.callsTo("GET", `${BASE}/messages`)[1]!.url.searchParams;
    assert.equal(list.get("q"), "newer_than:120d -in:chats");
    assert.equal(list.get("maxResults"), "100");
    assert.equal(list.get("includeSpamTrash"), "true");

    const [m2, m3, m4] = first.messages;
    assert.equal(m2!.remoteThreadId, "t1");
    assert.equal(m2!.folders.sent, true);
    assert.equal(m2!.outgoing, true);
    assert.equal(m2!.unread, false);
    assert.deepEqual(m3!.folders, { inbox: false, sent: false, trash: true, spam: false });
    assert.equal(m3!.starred, true);
    assert.equal(m4!.folders.spam, true);

    const [m1] = inbox.messages;
    assert.equal(m1!.remoteThreadId, "t1");
    assert.equal(m1!.subject, "Quarterly plan");
    assert.equal(m1!.messageIdHeader, "<m1@x>");
    assert.deepEqual(m1!.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.equal(m1!.unread, true);
    assert.equal(m1!.starred, false);
    assert.deepEqual(m1!.labels, [{ remoteId: "Label_1", name: "Clients" }]);
    assert.equal(m1!.outgoing, false);

    const second = await gmail.sync(first.cursor);
    assert.equal(second.done, true);
    assert.deepEqual(second.messages.map((m) => m.remoteId), ["m7"], "a draft and a chat are skipped");
    assert.deepEqual(second.messages[0]!.folders, { inbox: false, sent: false, trash: false, spam: false });
    assert.deepEqual(second.progress, { stage: "history", total: 7, count: 3, last: true });
    assert.deepEqual(JSON.parse(second.cursor!), { phase: "incremental", historyId: "100" });
    // The profile is read once, before listing.
    assert.equal(stub!.callsTo("GET", `${BASE}/profile`).length, 1);
    // Labels are only listed when a message carries a custom one, and then once per sync call.
    assert.equal(stub!.callsTo("GET", `${BASE}/labels`).length, 1);
  });

  it("fetches summaries only: a field-masked format=full, never a raw message", async () => {
    listing(sevenMessages());
    const { gmail } = newProvider();
    let page = await gmail.sync(null);
    for (let i = 0; i < 10 && !page.done; i++) page = await gmail.sync(page.cursor);
    const fetches = stub!.calls.filter((c) => /\/messages\/[^/]+$/.test(c.url.pathname) && c.method === "GET");
    assert.ok(fetches.length >= 6);
    for (const c of fetches) {
      assert.equal(c.url.searchParams.get("format"), "full");
      assert.ok(!/data/.test(c.url.searchParams.get("fields")!), "the mask names no body data");
    }
  });

  it("builds a summary from headers, the snippet and the part tree", async () => {
    const raw = Buffer.from(
      [
        "From: =?utf-8?B?SsOpcsO0bWU=?= <jerome@example.org>",
        "To: me@example.com",
        "Cc: Pat <pat@example.org>",
        "Subject: Statement",
        "Message-ID: <s1@x>",
        "In-Reply-To: <s0@x>",
        "References: <s-1@x> <s0@x>",
        "List-Unsubscribe: <https://news.example.org/u/9>, <mailto:u@news.example.org>",
        "List-Id: <news.example.org>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: multipart/alternative; boundary=\"c\"",
        "",
        "--c",
        "Content-Type: text/plain",
        "",
        "Your statement is attached. The code is 482913.",
        "--c",
        "Content-Type: text/html",
        "",
        "<p>Your statement</p>",
        "--c--",
        "--b",
        'Content-Type: application/pdf; name="statement.pdf"',
        'Content-Disposition: attachment; filename="statement.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "AAAA",
        "--b",
        "Content-Type: image/png",
        'Content-Disposition: inline; filename="logo.png"',
        "Content-ID: <logo@x>",
        "",
        "PNG",
        "--b--",
        "",
      ].join("\r\n"),
    );
    listing({ m1: { threadId: "t1", labelIds: ["INBOX"], raw, snippet: "Don&#39;t miss it &amp; more" } });
    const { gmail } = newProvider();
    const [m] = (await gmail.sync(null)).messages;
    assert.equal(m!.from.name, "Jérôme");
    assert.deepEqual(m!.cc, [{ name: "Pat", email: "pat@example.org" }]);
    assert.equal(m!.inReplyTo, "<s0@x>");
    assert.deepEqual(m!.references, ["<s-1@x>", "<s0@x>"]);
    assert.equal(m!.listUnsubscribe, "https://news.example.org/u/9, mailto:u@news.example.org");
    assert.equal(m!.bulk, true);
    assert.equal(m!.bodyComplete, false);
    assert.equal(m!.bodyText, "Don't miss it & more", "the snippet stands in for the body, entities decoded");
    assert.equal(m!.bodyHtml, undefined);
    assert.equal(m!.size, raw.length);
    assert.equal(m!.sentAt, 1791277200000, "no Date header: Gmail's own internal date");
    assert.deepEqual(
      m!.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, inline: a.inline, contentId: a.contentId, remoteId: a.remoteId })),
      [
        { filename: "statement.pdf", mimeType: "application/pdf", inline: false, contentId: undefined, remoteId: "part:2" },
        { filename: "logo.png", mimeType: "image/png", inline: true, contentId: "logo@x", remoteId: "part:3" },
      ],
    );
    assert.ok(m!.attachments.every((a) => a.content === undefined), "no attachment bytes");
  });

  it("brings the whole message when asked for it", async () => {
    const raw = Buffer.from(
      [
        "From: Ann <ann@example.org>",
        "To: me@example.com",
        "Subject: Full",
        "Message-ID: <f1@x>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>The <b>whole</b> thing</p>",
        "--b",
        "Content-Type: image/png",
        'Content-Disposition: inline; filename="logo.png"',
        "Content-ID: <logo@x>",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("PNGBYTES").toString("base64"),
        "--b",
        'Content-Type: application/pdf; name="a.pdf"',
        'Content-Disposition: attachment; filename="a.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("PDFBYTES").toString("base64"),
        "--b--",
        "",
      ].join("\r\n"),
    );
    stub = mailbox({ m1: { threadId: "t1", labelIds: ["INBOX"], raw } });
    const { gmail } = newProvider();
    const body = await gmail.fetchBody("m1");
    assert.deepEqual(formats(stub, "m1"), ["raw"]);
    assert.match(body.html!, /The <b>whole<\/b> thing/);
    assert.deepEqual(body.attachments.map((a) => [a.filename, a.remoteId, a.inline, a.content?.toString()]), [
      ["logo.png", "idx:0", true, "PNGBYTES"],
      ["a.pdf", "idx:1", false, undefined],
    ]);
  });
});

describe("Gmail incremental sync", () => {
  it("turns history into new messages, flag updates and deletions", async () => {
    const mail: Record<string, FakeMessage> = {
      m1: { threadId: "t1", labelIds: ["UNREAD", "STARRED", "Label_1"], raw: rawMail() },
      m5: { threadId: "t9", labelIds: ["INBOX", "UNREAD"], raw: rawMail({ subject: "New one", messageId: "<m5@x>" }) },
    };
    stub = mailbox(mail);
    stub.on("GET", `${BASE}/history`, (call: Call) => {
      assert.equal(call.url.searchParams.get("startHistoryId"), "100");
      assert.deepEqual(call.url.searchParams.getAll("historyTypes"), ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
      return call.url.searchParams.get("pageToken") === "h2"
        ? json({
            history: [{ id: "103", messagesAdded: [{ message: { id: "m7", threadId: "t7" } }] }],
            historyId: "110",
          })
        : json({
            history: [
              { id: "101", messagesAdded: [{ message: { id: "m5", threadId: "t9" } }] },
              { id: "102", labelsRemoved: [{ message: { id: "m1", threadId: "t1" }, labelIds: ["INBOX"] }] },
              { id: "102", messagesDeleted: [{ message: { id: "m2", threadId: "t1" } }] },
              { id: "102", messagesAdded: [{ message: { id: "m6", threadId: "t8" } }] },
              { id: "102", messagesDeleted: [{ message: { id: "m6", threadId: "t8" } }] },
            ],
            nextPageToken: "h2",
            historyId: "110",
          });
    });
    const { gmail } = newProvider();
    const page = await gmail.sync(JSON.stringify({ phase: "incremental", historyId: "100" }));

    assert.equal(page.done, true);
    assert.deepEqual(JSON.parse(page.cursor!), { phase: "incremental", historyId: "110" });
    // m7 vanished before it could be fetched; m6 was added and deleted in the same window.
    assert.deepEqual(page.messages.map((m) => m.remoteId), ["m5"]);
    assert.deepEqual(page.deletedRemoteIds?.sort(), ["m2", "m6"]);
    assert.equal(stub.callsTo("GET", `${BASE}/messages/m6`).length, 0);
    assert.deepEqual(page.flagUpdates, [
      {
        remoteId: "m1",
        unread: true,
        starred: true,
        folders: { inbox: false, sent: false, trash: false, spam: false },
        labels: [{ remoteId: "Label_1", name: "Clients" }],
      },
    ]);
    // New messages are fetched as summaries once; label-only changes use the minimal format.
    assert.deepEqual(stub.callsTo("GET", `${BASE}/messages/m5`).map((c) => c.url.searchParams.get("format")), ["full"]);
    assert.deepEqual(stub.callsTo("GET", `${BASE}/messages/m1`).map((c) => c.url.searchParams.get("format")), ["minimal"]);
  });

  it("hands control back after 20 history pages and resumes from the same start point", async () => {
    stub = mailbox({});
    let n = 0;
    stub.on("GET", `${BASE}/history`, () => json({ history: [], nextPageToken: `page${++n}`, historyId: "500" }));
    const { gmail } = newProvider();
    const page = await gmail.sync(JSON.stringify({ phase: "incremental", historyId: "100" }));
    assert.equal(page.done, false);
    assert.equal(stub.callsTo("GET", `${BASE}/history`).length, 20);
    assert.deepEqual(JSON.parse(page.cursor!), { phase: "incremental", historyId: "100", pageToken: "page20" });
  });

  it("starts over when Gmail no longer has the history", async () => {
    stub = mailbox({ m1: { threadId: "t1", labelIds: ["INBOX"], raw: rawMail() } });
    stub.on("GET", `${BASE}/history`, json({ error: { code: 404, message: "Requested entity was not found." } }, 404));
    stub.on("GET", `${BASE}/profile`, { historyId: "900" });
    stub.on("GET", `${BASE}/messages`, { messages: [{ id: "m1", threadId: "t1" }] });
    const { gmail } = newProvider();
    const page = await gmail.sync(JSON.stringify({ phase: "incremental", historyId: "5" }));
    // A fresh snapshot opens with the newest inbox mail, like any first sync.
    assert.deepEqual(page.messages.map((m) => m.remoteId), ["m1"]);
    assert.deepEqual(JSON.parse(page.cursor!), { phase: "initial", historyId: "900", top: true });
    assert.equal(page.done, false);
  });

  it("starts an initial sync from an unreadable cursor", async () => {
    stub = mailbox({});
    stub.on("GET", `${BASE}/profile`, { historyId: "7" });
    stub.on("GET", `${BASE}/messages`, {});
    const { gmail } = newProvider();
    const page = await gmail.sync("not json");
    assert.deepEqual(JSON.parse(page.cursor!), { phase: "initial", historyId: "7", top: true });
    assert.deepEqual(page.progress, { stage: "inbox", total: 0, count: 0, last: true });
  });
});

function thread(kind: RemoteAction["kind"], threadRemoteId: string, ids: string[]): RemoteAction {
  return { kind, threadRemoteId, messages: ids.map((remoteId) => ({ remoteId })) } as RemoteAction;
}

describe("Gmail actions", () => {
  it("modifies whole threads for real thread ids", async () => {
    stub = new FetchStub().on("POST", /\/threads\/t1\/modify$/, {});
    const { gmail } = newProvider();
    await gmail.apply(thread("archive", "t1", ["m1", "m2"]));
    await gmail.apply(thread("markRead", "t1", ["m1"]));
    await gmail.apply(thread("spam", "t1", ["m1"]));
    await gmail.apply(thread("unstar", "t1", ["m1", "m2"]));
    const sent = stub.calls.map(body);
    assert.deepEqual(sent[0], { addLabelIds: [], removeLabelIds: ["INBOX"] });
    assert.deepEqual(sent[1], { addLabelIds: [], removeLabelIds: ["UNREAD"] });
    assert.deepEqual(sent[2], { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
    assert.deepEqual(sent[3], { addLabelIds: [], removeLabelIds: ["STARRED"] });
  });

  it("batch-modifies messages for local ref: threads, skipping provisional ids", async () => {
    stub = new FetchStub().on("POST", `${BASE}/messages/batchModify`, empty204());
    const { gmail } = newProvider();
    await gmail.apply(thread("archive", "ref:<a@x>", ["m1", "sent:<b@x>", "m2"]));
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(body(stub.calls[0]!), { ids: ["m1", "m2"], addLabelIds: [], removeLabelIds: ["INBOX"] });
  });

  it("does nothing for a ref: thread that has no remote messages yet", async () => {
    stub = new FetchStub();
    const { gmail } = newProvider();
    await gmail.apply(thread("archive", "ref:<a@x>", ["sent:<b@x>"]));
    assert.equal(stub.calls.length, 0);
  });

  it("stars and marks unread only the newest message of a thread, never a draft", async () => {
    stub = new FetchStub()
      .on("GET", `${BASE}/threads/t1`, {
        id: "t1",
        messages: [{ id: "m1" }, { id: "m2" }, { id: "m3", labelIds: ["INBOX"] }, { id: "d1", labelIds: ["DRAFT"] }],
      })
      .on("POST", `${BASE}/messages/batchModify`, empty204());
    const { gmail } = newProvider();
    await gmail.apply(thread("star", "t1", ["m3", "m1", "m2"]));
    await gmail.apply(thread("markUnread", "t1", ["m3", "m1", "m2"]));
    const writes = stub.callsTo("POST", `${BASE}/messages/batchModify`).map(body);
    assert.deepEqual(writes[0], { ids: ["m3"], addLabelIds: ["STARRED"], removeLabelIds: [] });
    assert.deepEqual(writes[1], { ids: ["m3"], addLabelIds: ["UNREAD"], removeLabelIds: [] });
  });

  it("trashes threads, and puts untrashed ones back in the inbox", async () => {
    stub = new FetchStub()
      .on("POST", `${BASE}/threads/t1/trash`, {})
      .on("POST", `${BASE}/threads/t1/untrash`, {})
      .on("POST", `${BASE}/threads/t1/modify`, {})
      .on("POST", /\/messages\/[^/]+\/trash$/, {});
    const { gmail } = newProvider();
    await gmail.apply(thread("trash", "t1", ["m1"]));
    assert.equal(stub.callsTo("POST", `${BASE}/threads/t1/trash`).length, 1);
    await gmail.apply(thread("untrash", "t1", ["m1"]));
    assert.equal(stub.callsTo("POST", `${BASE}/threads/t1/untrash`).length, 1);
    assert.deepEqual(body(stub.callsTo("POST", `${BASE}/threads/t1/modify`)[0]!), { addLabelIds: ["INBOX"], removeLabelIds: [] });
    await gmail.apply(thread("trash", "ref:<a@x>", ["m1", "m2"]));
    assert.equal(stub.callsTo("POST", `${BASE}/messages/m1/trash`).length, 1);
    assert.equal(stub.callsTo("POST", `${BASE}/messages/m2/trash`).length, 1);
  });

  it("finds labels by name regardless of case and by id", async () => {
    stub = new FetchStub()
      .on("GET", `${BASE}/labels`, { labels: [{ id: "Label_1", name: "Clients", type: "user" }, { id: "INBOX", name: "INBOX", type: "system" }] })
      .on("POST", `${BASE}/threads/t1/modify`, {});
    const { gmail } = newProvider();
    await gmail.apply({ ...thread("addLabel", "t1", ["m1"]), label: { remoteId: "name:clients", name: "clients" } } as RemoteAction);
    await gmail.apply({ ...thread("removeLabel", "t1", ["m1"]), label: { remoteId: "Label_1", name: "Whatever" } } as RemoteAction);
    const writes = stub.callsTo("POST", `${BASE}/threads/t1/modify`).map(body);
    assert.deepEqual(writes[0], { addLabelIds: ["Label_1"], removeLabelIds: [] });
    assert.deepEqual(writes[1], { addLabelIds: [], removeLabelIds: ["Label_1"] });
    assert.equal(stub.callsTo("GET", `${BASE}/labels`).length, 1);
  });

  it("creates a missing label before applying it", async () => {
    stub = new FetchStub()
      .on("GET", `${BASE}/labels`, { labels: [] })
      .on("POST", `${BASE}/labels`, (call: Call) => json({ id: "Label_9", name: body(call).name, type: "user" }))
      .on("POST", `${BASE}/threads/t1/modify`, {});
    const { gmail } = newProvider();
    await gmail.apply({ ...thread("addLabel", "t1", ["m1"]), label: { remoteId: "name:Receipts", name: "Receipts" } } as RemoteAction);
    assert.equal(body(stub.callsTo("POST", `${BASE}/labels`)[0]!).name, "Receipts");
    assert.deepEqual(body(stub.callsTo("POST", `${BASE}/threads/t1/modify`)[0]!), { addLabelIds: ["Label_9"], removeLabelIds: [] });
  });

  it("does not create a label just to remove it", async () => {
    stub = new FetchStub().on("GET", `${BASE}/labels`, { labels: [] });
    const { gmail } = newProvider();
    await gmail.apply({ ...thread("removeLabel", "t1", ["m1"]), label: { remoteId: "name:Nope", name: "Nope" } } as RemoteAction);
    assert.equal(stub.callsTo("POST", `${BASE}/labels`).length, 0);
    assert.equal(stub.callsTo("POST", `${BASE}/threads/t1/modify`).length, 0);
  });

  it("looks the label up again when another client created it first", async () => {
    let listed = 0;
    stub = new FetchStub()
      .on("GET", `${BASE}/labels`, () => json({ labels: ++listed >= 3 ? [{ id: "Label_5", name: "Receipts", type: "user" }] : [] }))
      .on("POST", `${BASE}/labels`, json({ error: { code: 409, message: "Label name exists or conflicts" } }, 409))
      .on("POST", `${BASE}/threads/t1/modify`, {});
    const { gmail } = newProvider();
    await gmail.apply({ ...thread("addLabel", "t1", ["m1"]), label: { remoteId: "name:Receipts", name: "Receipts" } } as RemoteAction);
    assert.deepEqual(body(stub.callsTo("POST", `${BASE}/threads/t1/modify`)[0]!), { addLabelIds: ["Label_5"], removeLabelIds: [] });
  });

  it("sends raw MIME in the reply's thread", async () => {
    stub = new FetchStub().on("POST", `${BASE}/messages/send`, { id: "sent1", threadId: "t1", labelIds: ["SENT"] });
    const { gmail } = newProvider();
    const raw = rawMail({ from: "me@example.com", to: "ann@example.org", subject: "Re: Plan" });
    const message = outgoing(raw, "t1");
    const result = await gmail.apply({ kind: "send", message });
    assert.deepEqual(result, { remoteId: "sent1" });
    assert.deepEqual(body(stub.calls[0]!), { raw: raw.toString("base64url"), threadId: "t1" });
    assert.equal(Buffer.from(body(stub.calls[0]!).raw as string, "base64url").toString(), raw.toString());
  });

  it("sends a new conversation without a threadId", async () => {
    stub = new FetchStub().on("POST", `${BASE}/messages/send`, { id: "sent2", threadId: "t2" });
    const { gmail } = newProvider();
    await gmail.apply({ kind: "send", message: outgoing(rawMail(), undefined) });
    await gmail.apply({ kind: "send", message: outgoing(rawMail(), "ref:<a@x>") });
    assert.equal("threadId" in body(stub.calls[0]!), false);
    assert.equal("threadId" in body(stub.calls[1]!), false);
  });

  it("gives up on actions for messages Gmail no longer has", async () => {
    stub = new FetchStub().on("POST", `${BASE}/threads/gone/modify`, json({ error: { code: 400, message: "Invalid id value" } }, 400));
    const { gmail } = newProvider();
    await assert.rejects(gmail.apply(thread("archive", "gone", ["m1"])), PermanentProviderError);
  });

  it("retries rate-limited actions later", async () => {
    stub = new FetchStub()
      .on("POST", `${BASE}/threads/t1/modify`, () => json({ error: { code: 403, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } }, 403));
    const { gmail } = newProvider();
    await assert.rejects(gmail.apply(thread("archive", "t1", ["m1"])), (err: Error) => !(err instanceof PermanentProviderError) && !(err instanceof ProviderAuthError) && /rateLimitExceeded/.test(err.message));
    stub.restore();
    stub = new FetchStub().on("POST", `${BASE}/threads/t1/modify`, json({ error: { code: 429, message: "Too many requests" } }, 429));
    await assert.rejects(newProvider().gmail.apply(thread("archive", "t1", ["m1"])), (err: Error) => err.constructor === Error || err.name === "GmailHttpError");
  });

  it("downloads an attachment by index from the raw message", async () => {
    const raw = Buffer.from(
      [
        "From: Ann <ann@example.org>",
        "To: me@example.com",
        "Subject: File",
        "Message-ID: <f1@x>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b",
        'Content-Type: application/octet-stream; name="a.bin"',
        'Content-Disposition: attachment; filename="a.bin"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("PAYLOAD").toString("base64"),
        "--b--",
        "",
      ].join("\r\n"),
    );
    stub = mailbox({ m1: { threadId: "t1", labelIds: ["INBOX"], raw } });
    const { gmail } = newProvider();
    const bytes = await gmail.fetchAttachment("m1", "idx:0");
    assert.equal(bytes.toString(), "PAYLOAD");
  });
});

describe("Gmail send-as list", () => {
  it("keeps verified aliases, with name, reply-to and a sanitized signature", async () => {
    stub = new FetchStub().on("GET", `${BASE}/settings/sendAs`, {
      sendAs: [
        { sendAsEmail: "me@example.com", isPrimary: true, isDefault: true, verificationStatus: "accepted" },
        { sendAsEmail: "help@fernpoint.test", displayName: "Fernpoint Help", replyToAddress: "desk@fernpoint.test", signature: "<p>Best</p><script>x()</script>", verificationStatus: "accepted" },
        { sendAsEmail: "legacy@fernpoint.test", displayName: "", replyToAddress: "", signature: "" },
        { sendAsEmail: "later@fernpoint.test", verificationStatus: "pending" },
        { sendAsEmail: "ME@example.com" },
      ],
    });
    const { gmail } = newProvider();
    assert.deepEqual(await gmail.listIdentities(), [
      { email: "help@fernpoint.test", name: "Fernpoint Help", replyTo: "desk@fernpoint.test", signatureHtml: "<p>Best</p>" },
      { email: "legacy@fernpoint.test", name: "", replyTo: undefined, signatureHtml: undefined },
    ]);
  });

  it("returns nothing for an account with no aliases", async () => {
    stub = new FetchStub().on("GET", `${BASE}/settings/sendAs`, {});
    assert.deepEqual(await newProvider().gmail.listIdentities(), []);
  });

  it("reports a missing permission as a sign-in problem, not as an empty list", async () => {
    stub = new FetchStub().on(
      "GET",
      `${BASE}/settings/sendAs`,
      json({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } }, 403),
    );
    await assert.rejects(newProvider().gmail.listIdentities(), ProviderAuthError);
  });
});

describe("Gmail authentication", () => {
  it("refreshes the token on a 401, saves it, and retries", async () => {
    stub = new FetchStub()
      .on("POST", TOKEN, { access_token: "tok-2", expires_in: 3600 })
      .on("POST", `${BASE}/threads/t1/modify`, (call: Call) => (call.headers.get("authorization") === "Bearer tok-2" ? json({}) : json({ error: { code: 401, message: "Invalid Credentials" } }, 401)));
    const { gmail, ctx } = newProvider();
    await gmail.apply(thread("archive", "t1", ["m1"]));
    assert.equal(stub.callsTo("POST", `${BASE}/threads/t1/modify`).length, 2);
    assert.equal(ctx.saved.length, 1);
    assert.deepEqual({ ...(ctx.saved[0] as object), expiresAt: 0 }, { accessToken: "tok-2", refreshToken: "ref-1", expiresAt: 0 });
    // Later requests use the new token without refreshing again.
    await gmail.apply(thread("archive", "t1", ["m1"]));
    assert.equal(stub.callsTo("POST", TOKEN).length, 1);
  });

  it("asks for a new sign-in when the refresh token was revoked", async () => {
    stub = new FetchStub()
      .on("POST", TOKEN, json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400))
      .on("GET", `${BASE}/profile`, json({ error: { code: 401, message: "Invalid Credentials" } }, 401));
    const { gmail, ctx } = newProvider();
    await assert.rejects(gmail.sync(null), ProviderAuthError);
    assert.equal(ctx.saved.length, 0);
  });

  it("refreshes before the first call when the access token is about to expire", async () => {
    stub = new FetchStub()
      .on("POST", TOKEN, { access_token: "tok-2", expires_in: 3600 })
      .on("GET", `${BASE}/profile`, { historyId: "1" })
      .on("GET", `${BASE}/messages`, {});
    const { gmail } = newProvider({ auth: { accessToken: "tok-1", refreshToken: "ref-1", expiresAt: Date.now() + 10_000 } });
    await gmail.sync(null);
    assert.equal(stub.callsTo("GET", `${BASE}/profile`)[0]!.headers.get("authorization"), "Bearer tok-2");
  });
});

describe("Gmail into the store", () => {
  it("groups a synced conversation into one thread and applies later label changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slipstream-gmail-"));
    const db = new Db(join(dir, "test.db"));
    try {
      const mail: Record<string, FakeMessage> = {
        m1: { threadId: "t1", labelIds: ["INBOX", "UNREAD"], raw: rawMail({ subject: "Quarterly plan", messageId: "<m1@x>", date: "Tue, 06 Oct 2026 09:00:00 +0000" }) },
        m2: { threadId: "t1", labelIds: ["SENT"], raw: rawMail({ from: "me@example.com", to: "ann@example.org", subject: "Re: Quarterly plan", messageId: "<m2@x>", inReplyTo: "<m1@x>", date: "Tue, 06 Oct 2026 10:00:00 +0000" }) },
        m3: { threadId: "t2", labelIds: ["INBOX", "UNREAD"], raw: rawMail({ subject: "Lunch?", messageId: "<m3@x>" }) },
      };
      stub = mailbox(mail);
      stub.on("GET", `${BASE}/profile`, { historyId: "100" });
      stub.on("GET", `${BASE}/messages`, { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
      const { gmail } = newProvider();

      db.run("INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'me@example.com', 'Me', 0)");
      db.run("INSERT INTO accounts (id, user_id, provider, email, name, created_at) VALUES ('acc1', 'u1', 'gmail', 'me@example.com', 'Me', 0)");
      const account = db.get<AccountRow>("SELECT * FROM accounts WHERE id = 'acc1'")!;
      const store = new MailStore(db, dir);

      let page = await gmail.sync(null);
      const touched = new Set(store.ingest(account, page));
      while (!page.done) {
        page = await gmail.sync(page.cursor);
        for (const t of store.ingest(account, page)) touched.add(t);
      }
      assert.equal(touched.size, 2);
      // Everything arrived as a summary: the preview stands in for the body until the message is opened.
      assert.deepEqual(db.all<{ body_state: string }>("SELECT DISTINCT body_state FROM messages").map((r) => r.body_state), ["none"]);

      const threads = db.all<{ remote_id: string; message_count: number; in_inbox: number; unread_count: number; in_sent: number }>(
        "SELECT remote_id, message_count, in_inbox, unread_count, in_sent FROM threads ORDER BY remote_id",
      );
      assert.deepEqual(threads.map((t) => ({ ...t })), [
        { remote_id: "t1", message_count: 2, in_inbox: 1, unread_count: 1, in_sent: 1 },
        { remote_id: "t2", message_count: 1, in_inbox: 1, unread_count: 1, in_sent: 0 },
      ]);

      // The user archives t1 elsewhere and reads it: the next history pass says so.
      stub.on("GET", `${BASE}/history`, {
        history: [{ id: "101", labelsRemoved: [{ message: { id: "m1" }, labelIds: ["INBOX", "UNREAD"] }] }],
        historyId: "101",
      });
      mail.m1!.labelIds = [];
      const next = await gmail.sync(page.cursor);
      store.ingest(account, next);
      const t1 = db.get<{ in_inbox: number; unread_count: number }>("SELECT in_inbox, unread_count FROM threads WHERE remote_id = 't1'")!;
      assert.deepEqual({ ...t1 }, { in_inbox: 0, unread_count: 0 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function empty204(): Response {
  return new Response(null, { status: 204 });
}

function outgoing(raw: Buffer, threadRemoteId: string | undefined): OutgoingMessage {
  return {
    from: { name: "", email: "me@example.com" },
    to: [{ name: "", email: "ann@example.org" }],
    cc: [],
    bcc: [],
    subject: "Re: Plan",
    html: "<p>ok</p>",
    text: "ok",
    threadRemoteId,
    raw,
    messageIdHeader: "<out@x>",
  };
}
