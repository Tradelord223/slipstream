import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nodemailer from "nodemailer";
import { PermanentProviderError, ProviderAuthError, type OutgoingMessage, type SyncPage, type ThreadRef } from "../src/mail/types.ts";
import {
  IMAP_PRESETS,
  ImapProvider,
  compressUids,
  describeStructure,
  detectMailboxes,
  expandUids,
  finishBatch,
  findExpunged,
  friendlyError,
  gmailLabels,
  keywordFor,
  parseCursor,
  savesSentMail,
  serializeCursor,
  stripBccHeader,
  syncTargets,
  type ImapDeps,
  type ImapSettings,
} from "../src/providers/imap.ts";
import { FakeServer, type FakeConn, type FakeOptions } from "./fake-imap.ts";
import { structureOf } from "./mime-fake.ts";

const DAY = 86_400_000;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "latin1");

/* ------------------------------------------------------------------ pure pieces */

describe("Bcc stripping", () => {
  const strip = (s: string) => stripBccHeader(Buffer.from(s, "latin1")).toString("latin1");

  it("removes a Bcc header and nothing else", () => {
    const raw = "From: a@x.com\r\nBcc: secret@x.com\r\nTo: b@x.com\r\nSubject: hi\r\n\r\nBcc: this is body text\r\n";
    assert.equal(strip(raw), "From: a@x.com\r\nTo: b@x.com\r\nSubject: hi\r\n\r\nBcc: this is body text\r\n");
  });

  it("removes folded continuation lines", () => {
    const raw = "From: a@x.com\r\nBcc: one@x.com,\r\n two@x.com,\r\n\tthree@x.com\r\nTo: b@x.com\r\n\r\nbody";
    assert.equal(strip(raw), "From: a@x.com\r\nTo: b@x.com\r\n\r\nbody");
  });

  it("handles a Bcc header that is first, last, or lower case, with LF endings", () => {
    assert.equal(strip("Bcc: a@x.com\nTo: b@x.com\n\nbody"), "To: b@x.com\n\nbody");
    assert.equal(strip("To: b@x.com\nbcc: a@x.com\n\nbody"), "To: b@x.com\n\nbody");
    assert.equal(strip("To: b@x.com\nBCC : a@x.com\n b@x.com\n\nbody"), "To: b@x.com\n\nbody");
  });

  it("ignores similar header names and returns the same buffer when there is nothing to strip", () => {
    const raw = Buffer.from("To: b@x.com\r\nX-Bcc: a@x.com\r\nBccish: no\r\n\r\nbody");
    assert.equal(stripBccHeader(raw), raw);
  });

  it("keeps 8-bit bytes in the body and headers untouched", () => {
    const raw = Buffer.concat([Buffer.from("Bcc: a@x.com\r\nSubject: caf"), Buffer.from([0xe9]), Buffer.from("\r\n\r\n"), Buffer.from([0x00, 0xff, 0x80, 0x0a])]);
    const out = stripBccHeader(raw);
    assert.ok(out.equals(Buffer.concat([Buffer.from("Subject: caf"), Buffer.from([0xe9]), Buffer.from("\r\n\r\n"), Buffer.from([0x00, 0xff, 0x80, 0x0a])])));
  });

  it("copes with a header-only message", () => {
    assert.equal(strip("To: b@x.com\r\nBcc: a@x.com\r\n"), "To: b@x.com\r\n");
  });
});

describe("mailbox roles", () => {
  const box = (path: string, specialUse?: string, flags: string[] = []) => ({
    path,
    name: path.split(/[/.]/).pop()!,
    flags: new Set(flags),
    specialUse,
  });

  it("prefers special-use flags", () => {
    const map = detectMailboxes([
      box("INBOX", "\\Inbox"),
      box("Gesendet", "\\Sent"),
      box("Papierkorb", "\\Trash"),
      box("Werbung", "\\Junk"),
      box("Ablage", "\\Archive"),
      box("[Gmail]/All Mail", "\\All"),
      box("Sent"),
    ]);
    assert.deepEqual(map, {
      inbox: "INBOX",
      sent: "Gesendet",
      trash: "Papierkorb",
      junk: "Werbung",
      archive: "Ablage",
      all: "[Gmail]/All Mail",
    });
  });

  it("falls back to common names, shallowest first", () => {
    const map = detectMailboxes([
      box("INBOX"),
      box("INBOX.Sent Items"),
      box("Deleted Items"),
      box("Junk E-mail"),
      box("Old/Archive"),
      box("Archive"),
    ]);
    assert.equal(map.inbox, "INBOX");
    assert.equal(map.sent, "INBOX.Sent Items");
    assert.equal(map.trash, "Deleted Items");
    assert.equal(map.junk, "Junk E-mail");
    assert.equal(map.archive, "Archive");
    assert.equal(map.all, undefined);
  });

  it("ignores mailboxes that can't be selected", () => {
    const map = detectMailboxes([box("INBOX"), box("Trash", "\\Trash", ["\\Noselect"]), box("Deleted Messages")]);
    assert.equal(map.trash, "Deleted Messages");
  });

  it("chooses what to sync", () => {
    const generic = syncTargets({ inbox: "INBOX", sent: "Sent", trash: "Trash", junk: "Junk" }, false);
    assert.deepEqual(generic.map((t) => t.role), ["inbox", "sent", "trash", "junk"]);
    assert.deepEqual(
      syncTargets({ inbox: "INBOX", sent: "[Gmail]/Sent Mail", all: "[Gmail]/All Mail", trash: "[Gmail]/Trash", junk: "[Gmail]/Spam" }, true).map((t) => t.path),
      ["[Gmail]/All Mail", "[Gmail]/Trash", "[Gmail]/Spam"],
    );
    assert.deepEqual(syncTargets({}, false), [{ path: "INBOX", role: "inbox" }]);
    assert.throws(() => syncTargets({ inbox: "INBOX" }, true), /All Mail/);
  });
});

describe("cursor", () => {
  it("round-trips and survives garbage", () => {
    const c = parseCursor(null);
    c.boxes["INBOX"] = { uidValidity: "1700000000", lastUid: 42, highestModseq: "9007199254740993", window: "1:3,7" };
    c.step = 3;
    assert.deepEqual(parseCursor(serializeCursor(c)), c);
    assert.deepEqual(parseCursor("not json"), { v: 1, step: 0, boxes: {} });
    assert.deepEqual(parseCursor('{"v":2}'), { v: 1, step: 0, boxes: {} });
    const partial = parseCursor('{"v":1,"step":1,"boxes":{"A":{"uidValidity":"1","lastUid":3},"B":{"lastUid":"x"}}}');
    assert.deepEqual(Object.keys(partial.boxes), ["A"]);
  });

  it("advances lastUid batch by batch", () => {
    const st = { uidValidity: "1", lastUid: 0 };
    finishBatch(st, 30, 20);
    assert.equal(st.lastUid, 30);
    finishBatch(st, 60, 0);
    assert.equal(st.lastUid, 60);
    finishBatch(st, undefined, 0);
    assert.equal(st.lastUid, 60);
  });

  it("compresses UID windows", () => {
    assert.equal(compressUids([1, 2, 3, 7, 9, 10]), "1:3,7,9:10");
    assert.equal(compressUids([]), "");
    assert.deepEqual(expandUids("1:3,7,9:10"), [1, 2, 3, 7, 9, 10]);
    assert.deepEqual(expandUids(undefined), []);
  });

  it("finds expunges only inside the current window", () => {
    const now = [10, 11, 13].map((uid) => ({ uid, deleted: false }));
    assert.deepEqual(findExpunged([5, 10, 11, 12, 13], now, false), [12], "UID 5 merely left the window");
    assert.deepEqual(findExpunged([10, 11], [{ uid: 10, deleted: false }, { uid: 11, deleted: true }], false), [11], "\\Deleted counts");
    assert.deepEqual(findExpunged([3, 4], [], true), [3, 4], "an empty mailbox expunged everything");
  });
});

describe("small helpers", () => {
  it("splits Gmail labels into system flags and user labels", () => {
    assert.deepEqual(gmailLabels(new Set(["\\Inbox", "\\Important", "\\Starred", "Clients", "Clients/Acme"])), {
      inbox: true,
      sent: false,
      starred: true,
      draft: false,
      user: [
        { remoteId: "Clients", name: "Clients" },
        { remoteId: "Clients/Acme", name: "Clients/Acme" },
      ],
    });
  });

  it("makes atom-safe keywords", () => {
    assert.equal(keywordFor("Big Clients"), "Big_Clients");
    assert.equal(keywordFor('Q1 "plan" (draft)'), "Q1_plan_draft");
    assert.equal(keywordFor("日本語"), null);
  });

  it("knows which providers file sent mail themselves", () => {
    for (const h of ["imap.gmail.com", "outlook.office365.com", "imap.mail.me.com", "imap-mail.outlook.com"]) assert.equal(savesSentMail(h), true, h);
    for (const h of ["imap.fastmail.com", "imap.mail.yahoo.com", "127.0.0.1"]) assert.equal(savesSentMail(h), false, h);
  });

  it("ships the documented presets", () => {
    assert.deepEqual(Object.keys(IMAP_PRESETS), ["gmail", "icloud", "fastmail", "yahoo", "zoho", "proton"]);
    assert.equal(IMAP_PRESETS["icloud"]!.smtpPort, 587);
    assert.equal(IMAP_PRESETS["icloud"]!.smtpSecure, false);
    assert.equal(IMAP_PRESETS["proton"]!.imapHost, "127.0.0.1");
    assert.equal(IMAP_PRESETS["proton"]!.imapSecure, false);
    assert.match(IMAP_PRESETS["gmail"]!.help, /apppasswords/);
    for (const p of Object.values(IMAP_PRESETS)) assert.ok(p.label && p.help);
  });

  it("explains connection failures in plain words", () => {
    assert.match(friendlyError(Object.assign(new Error("x"), { code: "ENOTFOUND" }), "IMAP", "imap.nope.test").message, /Couldn't find the server imap\.nope\.test/);
    assert.match(friendlyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "SMTP", "127.0.0.1").message, /refused/);
    assert.match(friendlyError(Object.assign(new Error("x"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }), "IMAP", "h").message, /doesn't speak TLS/);
    assert.match(friendlyError(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "IMAP", "h").message, /certificate/);
    const auth = friendlyError(Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "Invalid credentials" }), "IMAP", "h");
    assert.ok(auth instanceof ProviderAuthError);
    assert.match(auth.message, /Invalid credentials/);
    assert.ok(friendlyError(Object.assign(new Error("x"), { code: "EAUTH" }), "SMTP", "h") instanceof ProviderAuthError);
  });
});

/* ------------------------------------------------------------------ the provider, against a fake server */

const SETTINGS: ImapSettings = {
  username: "me@example.com",
  password: "pw",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
};

interface Rig {
  server: FakeServer;
  provider: ImapProvider;
  conns: FakeConn[];
  sent: { envelope: { from: string; to: string[] }; raw: Buffer }[];
  wire: Buffer[];
}

function rig(server: FakeServer, over: { settings?: Partial<ImapSettings>; days?: number; deps?: ImapDeps } = {}): Rig {
  const conns: FakeConn[] = [];
  const sent: Rig["sent"] = [];
  const wire: Buffer[] = [];
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const provider = new ImapProvider(
    {
      accountId: "acc1",
      email: "me@example.com",
      auth: { ...SETTINGS, ...over.settings },
      saveAuth() {},
      initialSyncDays: over.days ?? 30,
    },
    {
      createClient: () => {
        const c = server.connect();
        conns.push(c);
        return c.asClient();
      },
      createTransport: () => ({
        // Real nodemailer, without the network: proves the raw bytes and explicit envelope go through as given.
        sendMail: async (opts: Parameters<typeof stream.sendMail>[0]) => {
          const info = await stream.sendMail(opts);
          sent.push({ envelope: info.envelope as Rig["sent"][number]["envelope"], raw: info.message as Buffer });
          wire.push(info.message as Buffer);
          return info;
        },
        close() {},
      }) as unknown as ReturnType<NonNullable<ImapDeps["createTransport"]>>,
      ...over.deps,
    },
  );
  return { server, provider, conns, sent, wire };
}

function mail(o: { id: string; from?: string; to?: string; subject?: string; date?: Date; inReplyTo?: string; body?: string; bcc?: string }): string {
  return [
    `Message-ID: <${o.id}@example.com>`,
    `From: ${o.from ?? "Alice <alice@example.com>"}`,
    `To: ${o.to ?? "me@example.com"}`,
    o.bcc ? `Bcc: ${o.bcc}` : undefined,
    `Subject: ${o.subject ?? `Subject ${o.id}`}`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`,
    o.inReplyTo ? `In-Reply-To: <${o.inReplyTo}@example.com>` : undefined,
    "",
    o.body ?? `Body of ${o.id}`,
    "",
  ]
    .filter((l) => l !== undefined)
    .join("\r\n");
}

function genericServer(opts?: FakeOptions): FakeServer {
  const s = new FakeServer(opts);
  s.add("INBOX", "\\Inbox");
  s.add("Sent", "\\Sent");
  s.add("Trash", "\\Trash");
  s.add("Junk", "\\Junk");
  return s;
}

function gmailServer(): FakeServer {
  const s = new FakeServer({ capabilities: ["IMAP4rev1", "UIDPLUS", "MOVE", "X-GM-EXT-1"], condstore: true });
  s.add("INBOX", "\\Inbox");
  s.add("[Gmail]/All Mail", "\\All");
  s.add("[Gmail]/Sent Mail", "\\Sent");
  s.add("[Gmail]/Trash", "\\Trash");
  s.add("[Gmail]/Spam", "\\Junk");
  s.add("[Gmail]/Drafts", "\\Drafts");
  return s;
}

async function drain(p: ImapProvider, cursor: string | null) {
  const pages: SyncPage[] = [];
  for (let i = 0; i < 500; i++) {
    const page = await p.sync(cursor);
    pages.push(page);
    cursor = page.cursor;
    if (page.done) break;
  }
  assert.equal(pages.at(-1)!.done, true, "a round ends with done: true");
  return {
    pages,
    cursor,
    messages: pages.flatMap((pg) => pg.messages),
    flags: pages.flatMap((pg) => pg.flagUpdates ?? []),
    deleted: pages.flatMap((pg) => pg.deletedRemoteIds ?? []),
  };
}

function thread(...refs: ([string, string] | [string])[]): ThreadRef {
  return { threadRemoteId: "t1", messages: refs.map(([remoteId, id]) => ({ remoteId, messageIdHeader: id ?? null })) };
}

const noLocksLeft = (r: Rig) => assert.deepEqual(r.conns.map((c) => c.openLocks), r.conns.map(() => 0), "every mailbox lock was released");

describe("ImapProvider ownership", () => {
  it("calls a message ours because of the Sent folder, never because of its From header", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "forged", from: "Me <me@example.com>" }));
    s.deliver("INBOX", mail({ id: "forged-alias", from: "Help <help@example.com>" }));
    s.deliver("Sent", mail({ id: "aliased", from: "Help <help@example.com>", to: "alice@example.com" }), { flags: ["\\Seen"] });
    const r = rig(s);
    const by = new Map((await drain(r.provider, null)).messages.map((m) => [m.messageIdHeader, m]));
    assert.equal(by.get("<forged@example.com>")!.outgoing, false);
    assert.equal(by.get("<forged-alias@example.com>")!.outgoing, false);
    assert.equal(by.get("<aliased@example.com>")!.outgoing, true);
  });
});

describe("ImapProvider sync (generic server)", () => {
  it("opens with the newest 100 inbox summaries, then the rest of the window newest first, with folders, flags and ids", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "ancient", date: new Date(Date.now() - 400 * DAY) }), { date: new Date(Date.now() - 400 * DAY) });
    for (let i = 0; i < 120; i++) s.deliver("INBOX", mail({ id: `in${i}` }), { flags: i === 0 ? ["\\Flagged", "\\Seen"] : [] });
    s.deliver("Sent", mail({ id: "out1", from: "Me <me@example.com>", to: "alice@example.com" }), { flags: ["\\Seen"] });
    s.deliver("Trash", mail({ id: "bin1" }));
    s.deliver("Junk", mail({ id: "spam1" }), { flags: ["\\Seen"] });
    s.deliver("INBOX", mail({ id: "draft1" }), { flags: ["\\Draft"] });
    const r = rig(s);

    const first = await r.provider.sync(null);
    // The draft is the newest UID: it takes a place in the page and is skipped, leaving 99 summaries.
    assert.equal(first.messages.length, 99);
    assert.equal(first.done, false);
    assert.deepEqual(first.progress, { stage: "inbox", total: 100, count: 100, last: true });
    assert.deepEqual(first.messages.map((m) => m.remoteId).slice(0, 2), ["INBOX:1:23", "INBOX:1:24"], "newest 100 UIDs, oldest first within the page");
    assert.equal(first.messages.at(-1)!.remoteId, "INBOX:1:121");
    assert.ok(first.messages.every((m) => m.bodyComplete === false), "summaries, not messages");

    const all = await drain(r.provider, first.cursor);
    const ids = [first.messages, ...all.pages.map((p) => p.messages)].flat().map((m) => m.remoteId);
    assert.equal(new Set(ids).size, ids.length, "nothing arrives twice");
    assert.equal(ids.filter((id) => id.startsWith("INBOX:")).length, 120, "drafts and out-of-window mail are skipped");
    const history = all.pages.filter((p) => p.progress);
    assert.deepEqual(history.map((p) => p.progress!.stage), ["history", "history", "history", "history"]);
    assert.deepEqual(history.map((p) => p.progress!.count), [21, 1, 1, 1], "the rest of the inbox, then Sent, Trash and Junk");
    assert.ok(history.every((p) => p.progress!.total === 24), "counted up front: 21 + 1 + 1 + 1");
    assert.deepEqual(history.map((p) => p.progress!.last), [false, false, false, true]);

    const byId = new Map(all.messages.map((m) => [m.messageIdHeader, m]));
    assert.deepEqual(all.messages.slice(0, 2).map((m) => m.remoteId), ["INBOX:1:2", "INBOX:1:3"]);
    assert.deepEqual(first.messages[0]!.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.equal(first.messages[0]!.unread, true);
    assert.equal(all.messages[0]!.unread, false, "in0 was read and starred");
    assert.equal(all.messages[0]!.starred, true);
    const out = byId.get("<out1@example.com>")!;
    assert.deepEqual(out.folders, { inbox: false, sent: true, trash: false, spam: false });
    assert.equal(out.outgoing, true);
    assert.equal(byId.get("<bin1@example.com>")!.folders.trash, true);
    assert.equal(byId.get("<spam1@example.com>")!.folders.spam, true);
    assert.equal(byId.has("<draft1@example.com>"), false);
    assert.equal(byId.get("<bin1@example.com>")!.remoteThreadId, undefined, "threading is left to the store off Gmail");

    const cursor = parseCursor(all.cursor);
    assert.equal(cursor.boxes["INBOX"]!.lastUid, 122);
    assert.equal(cursor.boxes["INBOX"]!.initial, undefined);
    assert.equal(s.fullFetches, 0, "a first sync never downloads a whole message");
    noLocksLeft(r);
  });

  it("reads headers, structure and the first 2 KB of the text part, never the message", async () => {
    const s = genericServer();
    const html = `<html><body><p>${"Caf\u00e9 ".repeat(1000)}</p></body></html>`;
    s.deliver(
      "INBOX",
      [
        "Message-ID: <m1@example.com>",
        "From: =?utf-8?B?SsOpcsO0bWU=?= <jerome@example.com>",
        "To: me@example.com",
        "Subject: Menu",
        `Date: ${new Date().toUTCString()}`,
        "References: <r0@example.com> <r1@example.com>",
        "List-Unsubscribe: <https://news.example.com/u/1>",
        "Received: from far.away.example.com by mx.example.com; with a long routing trail",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="alt"',
        "",
        "--alt",
        "Content-Type: text/plain; charset=iso-8859-1",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Caf=E9 menu, with an equals sign =3D and a soft =",
        "break",
        "--alt",
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
        "--alt--",
        "",
      ].join("\r\n"),
    );
    s.deliver(
      "INBOX",
      [
        "Message-ID: <m2@example.com>",
        "From: Dora <dora@example.com>",
        "To: me@example.com",
        "Subject: Only html",
        `Date: ${new Date().toUTCString()}`,
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(`<p>${"Hello <b>there</b> ".repeat(300)}</p>`).toString("base64"),
        "",
      ].join("\r\n"),
    );
    const r = rig(s);
    const st = await drain(r.provider, null);
    const [m1, m2] = st.messages.sort((a, b) => a.remoteId.localeCompare(b.remoteId));
    assert.equal(m1!.from.name, "Jérôme");
    assert.deepEqual(m1!.references, ["<r0@example.com>", "<r1@example.com>"]);
    assert.equal(m1!.listUnsubscribe, "https://news.example.com/u/1");
    assert.equal(m1!.bodyText, "Café menu, with an equals sign = and a soft break", "the plain part, undone from quoted-printable and Latin-1");
    assert.equal(m1!.bodyHtml, undefined);
    assert.ok(m1!.size! > 5000);
    assert.match(m2!.bodyText, /^Hello there Hello there/, "html-only mail previews as text, from base64");
    assert.ok(m2!.bodyText.length <= 2000);
    assert.equal(s.fullFetches, 0);
    assert.ok(s.partFetches.length > 0 && s.partFetches.every((f) => f.maxLength === 2048), "previews are capped at 2048 bytes");
  });

  it("sends only new mail once the first sync is done, and nothing when idle", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "a" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    assert.equal(st.messages.length, 1);
    st = await drain(r.provider, st.cursor); // seeds the change window
    assert.equal(st.messages.length, 0);

    s.deliver("INBOX", mail({ id: "b" }));
    st = await drain(r.provider, st.cursor);
    assert.deepEqual(st.messages.map((m) => m.messageIdHeader), ["<b@example.com>"]);

    st = await drain(r.provider, st.cursor);
    assert.deepEqual([st.messages.length, st.flags.length, st.deleted.length], [0, 0, 0], "an idle round has nothing to say");
  });

  it("copes with 'N:*' returning the newest message when there is nothing new", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "only" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    for (let i = 0; i < 3; i++) {
      st = await drain(r.provider, st.cursor);
      assert.equal(st.messages.length, 0);
    }
  });

  it("reports flag changes once (no CONDSTORE: re-reads the newest 500)", async () => {
    const s = genericServer();
    const uid = s.deliver("INBOX", mail({ id: "a" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    st = await drain(r.provider, st.cursor);
    s.change("INBOX", uid, (m) => m.flags.add("\\Seen").add("\\Flagged"));
    st = await drain(r.provider, st.cursor);
    assert.deepEqual(st.flags, [{ remoteId: "INBOX:1:1", unread: false, starred: true }]);
    st = await drain(r.provider, st.cursor);
    assert.equal(st.flags.length, 0);
  });

  it("uses CHANGEDSINCE when the server has CONDSTORE", async () => {
    const s = genericServer({ condstore: true });
    const u1 = s.deliver("INBOX", mail({ id: "a" }));
    s.deliver("INBOX", mail({ id: "b" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    assert.ok(parseCursor(st.cursor).boxes["INBOX"]!.highestModseq);
    st = await drain(r.provider, st.cursor);
    assert.equal(st.flags.length, 0, "unchanged modseq: no fetch, no updates");

    s.change("INBOX", u1, (m) => m.flags.add("\\Seen"));
    s.log.length = 0;
    st = await drain(r.provider, st.cursor);
    assert.deepEqual(st.flags, [{ remoteId: "INBOX:1:1", unread: false, starred: false }]);
    assert.ok(s.log.some((l) => l.includes("changedSince")));
  });

  it("detects expunges, and deletes before it adds when mail moves between mailboxes", async () => {
    const s = genericServer();
    const uid = s.deliver("INBOX", mail({ id: "mover" }));
    s.deliver("INBOX", mail({ id: "stayer" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    st = await drain(r.provider, st.cursor);

    // Archive it in another client: the server makes a new UID in a new mailbox and expunges the old one.
    s.add("Archive", "\\Archive");
    s.deliver("Archive", s.find("INBOX", uid)!.source);
    s.expunge("INBOX", uid);
    st = await drain(r.provider, st.cursor);

    assert.deepEqual(st.deleted, ["INBOX:1:1"]);
    assert.deepEqual(st.messages.map((m) => [m.remoteId, m.messageIdHeader]), [["Archive:1:1", "<mover@example.com>"]]);
    const deletePage = st.pages.findIndex((p) => p.deletedRemoteIds?.length);
    const addPage = st.pages.findIndex((p) => p.messages.length);
    assert.ok(deletePage < addPage, "the store drops a duplicate Message-ID, so the old copy has to go first");
    assert.deepEqual(st.messages[0]!.folders, { inbox: false, sent: false, trash: false, spam: false }, "archived");

    st = await drain(r.provider, st.cursor);
    assert.deepEqual([st.messages.length, st.deleted.length], [0, 0]);
  });

  it("treats \\Deleted like an expunge", async () => {
    const s = genericServer();
    const uid = s.deliver("INBOX", mail({ id: "a" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    st = await drain(r.provider, st.cursor);
    s.change("INBOX", uid, (m) => m.flags.add("\\Deleted"));
    st = await drain(r.provider, st.cursor);
    assert.deepEqual(st.deleted, ["INBOX:1:1"]);
  });

  it("starts a mailbox over when UIDVALIDITY changes", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "a" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    st = await drain(r.provider, st.cursor);

    const box = s.boxes.get("INBOX")!;
    box.uidValidity = 7n;
    box.uidNext = 1;
    box.messages = [];
    s.deliver("INBOX", mail({ id: "a" }));
    s.deliver("INBOX", mail({ id: "c" }));
    st = await drain(r.provider, st.cursor);
    assert.deepEqual(st.messages.map((m) => m.remoteId), ["INBOX:7:1", "INBOX:7:2"]);
    assert.equal(parseCursor(st.cursor).boxes["INBOX"]!.uidValidity, "7");
  });

  it("resumes the first sync from the cursor after a restart, below what was already handed over", async () => {
    const s = genericServer();
    for (let i = 0; i < 250; i++) s.deliver("INBOX", mail({ id: `m${i}` }));
    const r1 = rig(s);
    const p1 = await r1.provider.sync(null);
    assert.equal(p1.messages.length, 100);
    const p2 = await r1.provider.sync(p1.cursor);
    assert.equal(p2.messages.length, 100);
    assert.deepEqual(parseCursor(p2.cursor!).boxes["INBOX"]!.initial?.low, 51);

    const r2 = rig(s); // a new provider has no in-memory queue
    const rest = await drain(r2.provider, p2.cursor);
    assert.deepEqual(rest.messages.map((m) => m.remoteId).slice(0, 2), ["INBOX:1:1", "INBOX:1:2"]);
    assert.equal(rest.messages.length, 50, "only what is below the lowest UID handed over");
    assert.equal(rest.pages.find((p) => p.progress)!.progress!.total, 50, "a restarted run counts what is left");
  });

  it("reconnects when the server drops the connection", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "a" }));
    const r = rig(s);
    let st = await drain(r.provider, null);
    r.conns[0]!.drop();
    s.deliver("INBOX", mail({ id: "b" }));
    st = await drain(r.provider, st.cursor);
    assert.equal(r.conns.length, 2);
    assert.deepEqual(st.messages.map((m) => m.messageIdHeader), ["<b@example.com>"]);
  });

  it("retries once when the connection dies mid-command", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "a" }));
    const r = rig(s);
    await r.provider.sync(null);
    const live = r.conns[0]!;
    const original = live.list.bind(live);
    live.list = async () => {
      live.usable = false;
      return original();
    };
    const page = await r.provider.sync(null);
    assert.equal(r.conns.length, 2);
    assert.ok(page.messages.length >= 0);
  });

  it("turns a login failure into ProviderAuthError", async () => {
    const s = genericServer();
    const p = new ImapProvider(
      { accountId: "a", email: "me@example.com", auth: SETTINGS, saveAuth() {}, initialSyncDays: 30 },
      {
        createClient: () => {
          const c = s.connect();
          c.connectError = Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "Invalid credentials" });
          return c.asClient();
        },
      },
    );
    await assert.rejects(p.sync(null), (err: Error) => err instanceof ProviderAuthError && /Invalid credentials/.test(err.message));
  });

  it("logs out on close", async () => {
    const s = genericServer();
    const r = rig(s);
    await r.provider.sync(null);
    await r.provider.close();
    assert.equal(r.conns[0]!.loggedOut, true);
  });
});

describe("ImapProvider sync (Gmail)", () => {
  it("reads All Mail, Trash and Spam, with threads and labels", async () => {
    const s = gmailServer();
    s.deliver("INBOX", mail({ id: "dup-inbox" })); // Gmail shows the same mail in INBOX; we never read it
    s.deliver("[Gmail]/All Mail", mail({ id: "a" }), { labels: ["\\Inbox", "Clients", "\\Important"], threadId: "1800" });
    s.deliver("[Gmail]/All Mail", mail({ id: "b", from: "Me <me@example.com>" }), { labels: ["\\Sent"], threadId: "1800", flags: ["\\Seen"] });
    s.deliver("[Gmail]/All Mail", mail({ id: "starred" }), { labels: ["\\Starred"], flags: ["\\Flagged"], threadId: "1801" });
    s.deliver("[Gmail]/All Mail", mail({ id: "draft" }), { labels: ["\\Draft"], flags: ["\\Draft"], threadId: "1802" });
    s.deliver("[Gmail]/Trash", mail({ id: "t" }), { labels: [], threadId: "1803" });
    s.deliver("[Gmail]/Spam", mail({ id: "sp" }), { labels: [], threadId: "1804" });
    const r = rig(s, { settings: { imapHost: "imap.gmail.com" } });

    const st = await drain(r.provider, null);
    const by = new Map(st.messages.map((m) => [m.messageIdHeader, m]));
    assert.equal(by.size, 5);
    assert.equal(by.has("<dup-inbox@example.com>"), false);
    assert.equal(by.has("<draft@example.com>"), false);

    const a = by.get("<a@example.com>")!;
    assert.equal(a.remoteId, "[Gmail]/All Mail:1:1");
    assert.equal(a.remoteThreadId, "1800");
    assert.deepEqual(a.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.deepEqual(a.labels, [{ remoteId: "Clients", name: "Clients" }]);
    const b = by.get("<b@example.com>")!;
    assert.equal(b.remoteThreadId, "1800");
    assert.deepEqual(b.folders, { inbox: false, sent: true, trash: false, spam: false });
    assert.equal(b.outgoing, true);
    assert.equal(by.get("<starred@example.com>")!.starred, true);
    assert.equal(by.get("<t@example.com>")!.folders.trash, true);
    assert.equal(by.get("<sp@example.com>")!.folders.spam, true);
  });

  it("notices an archive done elsewhere through the labels", async () => {
    const s = gmailServer();
    const uid = s.deliver("[Gmail]/All Mail", mail({ id: "a" }), { labels: ["\\Inbox"], threadId: "1" });
    const r = rig(s);
    let st = await drain(r.provider, null);
    st = await drain(r.provider, st.cursor);

    const msg = s.find("[Gmail]/All Mail", uid)!;
    msg.labels!.delete("\\Inbox");
    msg.labels!.add("Receipts");
    msg.modseq = ++s.boxes.get("[Gmail]/All Mail")!.highestModseq;
    st = await drain(r.provider, st.cursor);
    assert.equal(st.flags.length, 1);
    assert.equal(st.flags[0]!.folders?.inbox, false);
    assert.deepEqual(st.flags[0]!.labels, [{ remoteId: "Receipts", name: "Receipts" }]);
  });

  it("explains a missing All Mail", async () => {
    const s = gmailServer();
    s.boxes.delete("[Gmail]/All Mail");
    await assert.rejects(rig(s).provider.sync(null), /All Mail/);
  });
});

describe("ImapProvider actions (generic server)", () => {
  async function setup() {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "a" }));
    s.deliver("INBOX", mail({ id: "b" }));
    s.deliver("INBOX", mail({ id: "other" }));
    return { s, r: rig(s) };
  }
  const T = thread(["Stale:9:1", "<a@example.com>"], ["INBOX:1:2", "<b@example.com>"]);

  it("marks read and starred, finding messages by remote id or Message-ID", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "markRead", ...T });
    await r.provider.apply({ kind: "star", ...T });
    assert.deepEqual([...s.find("INBOX", 1)!.flags].sort(), ["\\Flagged", "\\Seen"]);
    assert.deepEqual([...s.find("INBOX", 2)!.flags].sort(), ["\\Flagged", "\\Seen"]);
    assert.equal(s.find("INBOX", 3)!.flags.size, 0);
    await r.provider.apply({ kind: "markUnread", ...T });
    await r.provider.apply({ kind: "unstar", ...T });
    // "Unread" is the newest message only, like the local store and Gmail.
    assert.deepEqual([...s.find("INBOX", 1)!.flags], ["\\Seen"]);
    assert.equal(s.find("INBOX", 2)!.flags.size, 0);
    noLocksLeft(r);
  });

  it("archives into the Archive folder, creating it when missing", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "archive", ...T });
    assert.ok(s.boxes.has("Archive"));
    assert.deepEqual(s.ids("Archive"), ["<a@example.com>", "<b@example.com>"]);
    assert.deepEqual(s.ids("INBOX"), ["<other@example.com>"]);

    await r.provider.apply({ kind: "unarchive", ...T });
    assert.deepEqual(s.ids("INBOX").sort(), ["<a@example.com>", "<b@example.com>", "<other@example.com>"]);
    assert.deepEqual(s.ids("Archive"), []);
    noLocksLeft(r);
  });

  it("doesn't create an Archive folder when there is nothing to archive", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "archive", ...thread(["INBOX:1:99", "<ghost@example.com>"]) });
    assert.equal(s.boxes.has("Archive"), false);
  });

  it("uses an existing Archive folder", async () => {
    const { s, r } = await setup();
    s.add("Archive", "\\Archive");
    await r.provider.apply({ kind: "archive", ...T });
    assert.equal(s.log.some((l) => l.startsWith("create")), false);
    assert.equal(s.ids("Archive").length, 2);
  });

  it("trashes from every mailbox and restores to the inbox", async () => {
    const { s, r } = await setup();
    s.deliver("Sent", mail({ id: "a-reply", from: "Me <me@example.com>" }));
    const t = thread(["INBOX:1:1", "<a@example.com>"], ["Sent:1:1", "<a-reply@example.com>"]);
    await r.provider.apply({ kind: "trash", ...t });
    assert.deepEqual(s.ids("Trash").sort(), ["<a-reply@example.com>", "<a@example.com>"]);
    assert.equal(s.ids("Sent").length, 0);

    await r.provider.apply({ kind: "untrash", ...t });
    assert.equal(s.ids("Trash").length, 0);
    assert.ok(s.ids("INBOX").includes("<a@example.com>"));
  });

  it("moves to Junk and back", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "spam", ...T });
    assert.equal(s.ids("Junk").length, 2);
    await r.provider.apply({ kind: "unspam", ...T });
    assert.equal(s.ids("Junk").length, 0);
    assert.equal(s.ids("INBOX").length, 3);
  });

  it("refuses to trash when the account has no Trash folder", async () => {
    const { s, r } = await setup();
    s.boxes.delete("Trash");
    await assert.rejects(r.provider.apply({ kind: "trash", ...T }), PermanentProviderError);
  });

  it("stores labels as IMAP keywords when the mailbox allows them", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "addLabel", label: { remoteId: "l1", name: "Big Clients" }, ...T });
    assert.ok(s.find("INBOX", 1)!.flags.has("Big_Clients"));
    await r.provider.apply({ kind: "removeLabel", label: { remoteId: "l1", name: "Big Clients" }, ...T });
    assert.ok(!s.find("INBOX", 1)!.flags.has("Big_Clients"));

    s.boxes.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged"]);
    await r.provider.apply({ kind: "addLabel", label: { remoteId: "l1", name: "Big Clients" }, ...T });
    assert.ok(!s.find("INBOX", 1)!.flags.has("Big_Clients"), "no custom keywords: quietly nothing");
  });

  it("downloads an attachment by re-reading the message", async () => {
    const s = genericServer();
    const raw = [
      "Message-ID: <att@example.com>",
      "From: Carol <carol@example.com>",
      "To: me@example.com",
      "Subject: Invoice",
      "Date: " + new Date().toUTCString(),
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--b1",
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      PDF.toString("base64"),
      "--b1--",
      "",
    ].join("\r\n");
    const uid = s.deliver("INBOX", raw);
    const r = rig(s);
    const st = await drain(r.provider, null);
    const summary = st.messages[0]!.attachments[0]!;
    assert.deepEqual([summary.filename, summary.mimeType, summary.remoteId, summary.inline], ["invoice.pdf", "application/pdf", "part:2", false]);
    assert.ok(Math.abs(summary.size - PDF.length) <= 2, "the size is the decoded one, worked out from the base64");
    assert.equal(summary.content, undefined, "bytes stay on the server until asked for");
    assert.equal(s.fullFetches, 0);
    const full = await r.provider.fetchBody(`INBOX:1:${uid}`);
    assert.equal(s.fullFetches, 1, "only opening the message downloads it");
    assert.equal(full.text.trim(), "See attached.");
    const att = full.attachments[0]!;
    assert.equal(att.remoteId, "idx:0");
    const bytes = await r.provider.fetchAttachment(`INBOX:1:${uid}`, att.remoteId!);
    assert.ok(bytes.equals(PDF));

    s.boxes.get("INBOX")!.uidValidity = 9n;
    await assert.rejects(r.provider.fetchAttachment(`INBOX:1:${uid}`, "idx:0"), /renumbered/);
    noLocksLeft(r);
  });
});

describe("ImapProvider actions (Gmail)", () => {
  async function setup() {
    const s = gmailServer();
    s.deliver("[Gmail]/All Mail", mail({ id: "a" }), { labels: ["\\Inbox"], threadId: "1" });
    s.deliver("[Gmail]/All Mail", mail({ id: "b" }), { labels: ["\\Inbox", "Clients"], threadId: "1" });
    return { s, r: rig(s, { settings: { imapHost: "imap.gmail.com" } }) };
  }
  const T = thread(["[Gmail]/All Mail:1:1", "<a@example.com>"], ["[Gmail]/All Mail:1:2", "<b@example.com>"]);

  it("archives by removing the Inbox label, and unarchives by adding it back", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "archive", ...T });
    assert.equal(s.find("[Gmail]/All Mail", 1)!.labels!.has("\\Inbox"), false);
    assert.equal(s.find("[Gmail]/All Mail", 2)!.labels!.has("Clients"), true);
    await r.provider.apply({ kind: "unarchive", ...T });
    assert.equal(s.find("[Gmail]/All Mail", 2)!.labels!.has("\\Inbox"), true);
  });

  it("adds and removes user labels as Gmail labels", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "addLabel", label: { remoteId: "Big Clients", name: "Big Clients" }, ...T });
    assert.equal(s.find("[Gmail]/All Mail", 1)!.labels!.has("Big Clients"), true);
    assert.equal(s.find("[Gmail]/All Mail", 1)!.flags.has("Big Clients"), false);
    await r.provider.apply({ kind: "removeLabel", label: { remoteId: "Clients", name: "Clients" }, ...T });
    assert.equal(s.find("[Gmail]/All Mail", 2)!.labels!.has("Clients"), false);
  });

  it("trashes by moving out of All Mail, and refuses a server without MOVE", async () => {
    const { s, r } = await setup();
    await r.provider.apply({ kind: "trash", ...T });
    assert.equal(s.ids("[Gmail]/Trash").length, 2);
    assert.equal(s.ids("[Gmail]/All Mail").length, 0);

    const nomove = gmailServer();
    nomove.capabilities.delete("MOVE");
    nomove.deliver("[Gmail]/All Mail", mail({ id: "a" }), { labels: ["\\Inbox"] });
    await assert.rejects(rig(nomove).provider.apply({ kind: "trash", ...thread(["[Gmail]/All Mail:1:1", "<a@example.com>"]) }), PermanentProviderError);
    assert.equal(nomove.ids("[Gmail]/All Mail").length, 1, "nothing was expunged");
  });
});

describe("ImapProvider send", () => {
  const out = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => {
    const raw = Buffer.from(
      [
        "Message-ID: <sent1@example.com>",
        "From: Me <me@example.com>",
        "To: Alice <alice@example.com>",
        "Cc: carol@example.com",
        "Bcc: Hidden One <hidden@example.com>,",
        "  second@example.com",
        "Subject: Hello",
        "Date: " + new Date().toUTCString(),
        "",
        "Hi Alice",
        "",
      ].join("\r\n"),
    );
    return {
      from: { name: "Me", email: "me@example.com" },
      to: [{ name: "Alice", email: "alice@example.com" }],
      cc: [{ name: "", email: "carol@example.com" }],
      bcc: [
        { name: "Hidden One", email: "hidden@example.com" },
        { name: "", email: "Second@example.com" },
      ],
      subject: "Hello",
      html: "<p>Hi Alice</p>",
      text: "Hi Alice",
      raw,
      messageIdHeader: "<sent1@example.com>",
      ...over,
    };
  };

  it("delivers to every recipient, hides Bcc on the wire, and files the original in Sent", async () => {
    const s = genericServer();
    const r = rig(s);
    const message = out();
    assert.deepEqual(await r.provider.apply({ kind: "send", message }), {});

    assert.deepEqual(r.sent[0]!.envelope, {
      from: "me@example.com",
      to: ["alice@example.com", "carol@example.com", "hidden@example.com", "second@example.com"],
    });
    const wire = r.wire[0]!.toString();
    assert.ok(!/bcc/i.test(wire) && !wire.includes("hidden@example.com"), "no Bcc on the wire");
    assert.ok(r.wire[0]!.equals(stripBccHeader(message.raw)));
    assert.match(wire, /Date: [^\r]*\r\n\r\nHi Alice/);

    assert.equal(s.appended.length, 1);
    assert.equal(s.appended[0]!.path, "Sent");
    assert.deepEqual(s.appended[0]!.flags, ["\\Seen"]);
    assert.ok(s.appended[0]!.raw.equals(message.raw), "the stored copy keeps its Bcc");
    noLocksLeft(r);
  });

  it("leaves filing to Gmail, iCloud and Outlook", async () => {
    const s = gmailServer();
    const r = rig(s, { settings: { imapHost: "imap.gmail.com" } });
    await r.provider.apply({ kind: "send", message: out() });
    assert.equal(r.sent.length, 1);
    assert.equal(s.appended.length, 0);
  });

  it("doesn't fail a delivered message because the Sent copy couldn't be saved", async () => {
    const s = genericServer();
    s.failAppend = true;
    const r = rig(s);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await r.provider.apply({ kind: "send", message: out() });
    } finally {
      console.warn = warn;
    }
    assert.equal(r.sent.length, 1);
  });

  it("rejects a message with nobody to send it to", async () => {
    const r = rig(genericServer());
    await assert.rejects(r.provider.apply({ kind: "send", message: out({ to: [], cc: [], bcc: [] }) }), PermanentProviderError);
    assert.equal(r.sent.length, 0);
  });

  it("maps SMTP refusals: 5xx is permanent, bad login needs reauth", async () => {
    const refuse = (err: object) =>
      rig(genericServer(), {
        deps: {
          createTransport: () => ({
            sendMail: async () => {
              throw Object.assign(new Error("Mail failed"), err);
            },
            close() {},
          }) as unknown as ReturnType<NonNullable<ImapDeps["createTransport"]>>,
        },
      });
    await assert.rejects(refuse({ responseCode: 550, response: "550 Mailbox unavailable" }).provider.apply({ kind: "send", message: out() }), PermanentProviderError);
    await assert.rejects(refuse({ code: "EAUTH", response: "535 bad credentials" }).provider.apply({ kind: "send", message: out() }), ProviderAuthError);
    await assert.rejects(
      refuse({ code: "ETIMEDOUT" }).provider.apply({ kind: "send", message: out() }),
      (err: Error) => !(err instanceof PermanentProviderError) && /didn't answer/.test(err.message),
    );
  });
});

describe("ImapProvider summaries", () => {
  it("describes a message's structure without downloading it", () => {
    const raw = [
      "From: a@example.com",
      "Content-Type: multipart/mixed; boundary=m",
      "",
      "--m",
      'Content-Type: multipart/alternative; boundary="a"',
      "",
      "--a",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "aGk=",
      "--a",
      "Content-Type: text/html",
      "",
      "<p>hi</p>",
      "--a--",
      "--m",
      'Content-Type: image/png; name="logo.png"',
      "Content-Disposition: inline",
      "Content-ID: <logo@x>",
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--m",
      "Content-Type: text/calendar",
      "",
      "BEGIN:VCALENDAR",
      "--m--",
      "",
    ].join("\r\n");
    const d = describeStructure(structureOf(Buffer.from(raw)));
    assert.deepEqual(d.text, { key: "1.1", type: "text/plain", encoding: "base64", charset: "utf-8" });
    assert.deepEqual(d.attachments.map((a) => [a.filename, a.mimeType, a.remoteId, a.inline, a.contentId]), [
      ["logo.png", "image/png", "part:2", true, "logo@x"],
      ["attachment", "text/calendar", "part:3", false, undefined],
    ]);
    assert.deepEqual(describeStructure(structureOf(Buffer.from("Subject: x\r\n\r\nhello"))).text?.key, "1", "a single-part message is part 1");
    assert.deepEqual(describeStructure(undefined), { attachments: [] });
  });

  it("on Gmail, reads the inbox's newest mail from All Mail first, then the rest of the window", async () => {
    const s = gmailServer();
    s.add("[Gmail]/Important", "\\Important");
    // 30 inbox messages from a while ago, then 150 newer ones that were archived: a plain newest-first read would show no inbox at all.
    for (let i = 0; i < 30; i++) s.deliver("[Gmail]/All Mail", mail({ id: `inbox${i}` }), { labels: ["\\Inbox"], threadId: `i${i}` });
    for (let i = 0; i < 150; i++) s.deliver("[Gmail]/All Mail", mail({ id: `archived${i}` }), { labels: [], threadId: `a${i}` });
    const r = rig(s, { settings: { imapHost: "imap.gmail.com" } });

    const first = await r.provider.sync(null);
    assert.deepEqual(first.progress, { stage: "inbox", total: 30, count: 30, last: true });
    assert.equal(first.messages.length, 30);
    assert.ok(first.messages.every((m) => m.folders.inbox && m.remoteThreadId?.startsWith("i")), "only inbox mail, with Gmail's thread ids");
    assert.ok(s.log.some((l) => l.includes('"gmraw":"in:inbox"')), "Gmail's own search finds the inbox");

    const rest = await drain(r.provider, first.cursor);
    const ids = rest.messages.map((m) => m.remoteId);
    assert.equal(ids.length, 150, "the inbox page isn't fetched twice");
    assert.deepEqual(rest.pages.filter((p) => p.progress).map((p) => [p.progress!.count, p.progress!.total]), [[100, 150], [50, 150]]);
    assert.equal(parseCursor(rest.cursor).boxes["[Gmail]/All Mail"]!.initial, undefined);
    assert.equal(s.fullFetches, 0);
  });

  it("opens the full message by id, and finds it by Message-ID when the id has gone stale", async () => {
    const s = genericServer();
    const uid = s.deliver("INBOX", mail({ id: "moving", body: "The whole text" }));
    s.deliver("INBOX", mail({ id: "stayer" }));
    const r = rig(s);
    await drain(r.provider, null);
    const id = `INBOX:1:${uid}`;
    assert.equal((await r.provider.fetchBody(id)).text.trim(), "The whole text");

    // Another client archives it: a new UID in another mailbox, the old one gone.
    s.add("Archive", "\\Archive");
    s.deliver("Archive", s.find("INBOX", uid)!.source);
    s.expunge("INBOX", uid);
    await assert.rejects(r.provider.fetchBody(id), /no longer in that mailbox/);
    const found = await r.provider.fetchBody(id, { messageIdHeader: "<moving@example.com>" });
    assert.equal(found.text.trim(), "The whole text");

    // The server renumbers a mailbox: the old ids mean nothing, but the Message-ID still does.
    s.boxes.get("Archive")!.uidValidity = 5n;
    await assert.rejects(r.provider.fetchBody("Archive:1:1"), /no longer in that mailbox/);
    assert.equal((await r.provider.fetchBody("Archive:1:1", { messageIdHeader: "<moving@example.com>" })).text.trim(), "The whole text");
    await assert.rejects(r.provider.fetchBody("not an id"), /Unrecognized/);
    noLocksLeft(r);
  });
});
