import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nodemailer from "nodemailer";
import { PermanentProviderError, ProviderAuthError, type OutgoingMessage, type SyncPage, type ThreadRef } from "../src/mail/types.ts";
import {
  IMAP_PRESETS,
  ImapProvider,
  compressUids,
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

  it("advances lastUid batch by batch and closes the first sync at its ceiling", () => {
    const st = { uidValidity: "1", lastUid: 0, initial: { since: 0, ceiling: 100 } };
    finishBatch(st, 30, 20);
    assert.equal(st.lastUid, 30);
    assert.ok(st.initial);
    finishBatch(st, 60, 0);
    assert.equal(st.lastUid, 100, "UIDs between the last match and UIDNEXT are skipped, not re-fetched");
    assert.equal("initial" in st, false);
    finishBatch(st, 130, 0);
    assert.equal(st.lastUid, 130);
    finishBatch(st, undefined, 0);
    assert.equal(st.lastUid, 130);
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

describe("ImapProvider sync (generic server)", () => {
  it("fetches recent mail in batches of 50, with folders, flags and ids", async () => {
    const s = genericServer();
    s.deliver("INBOX", mail({ id: "ancient", date: new Date(Date.now() - 400 * DAY) }), { date: new Date(Date.now() - 400 * DAY) });
    for (let i = 0; i < 120; i++) s.deliver("INBOX", mail({ id: `in${i}` }), { flags: i === 0 ? ["\\Flagged", "\\Seen"] : [] });
    s.deliver("Sent", mail({ id: "out1", from: "Me <me@example.com>", to: "alice@example.com" }), { flags: ["\\Seen"] });
    s.deliver("Trash", mail({ id: "bin1" }));
    s.deliver("Junk", mail({ id: "spam1" }), { flags: ["\\Seen"] });
    s.deliver("INBOX", mail({ id: "draft1" }), { flags: ["\\Draft"] });
    const r = rig(s);

    const first = await r.provider.sync(null);
    assert.equal(first.messages.length, 50);
    assert.equal(first.done, false);
    assert.equal(first.messages[0]!.remoteId, "INBOX:1:2", "the 400 day old message (uid 1) is outside the window");

    const all = await drain(r.provider, first.cursor);
    const inbox = [first.messages, ...all.pages.map((p) => p.messages)].flat().filter((m) => m.remoteId.startsWith("INBOX:"));
    assert.equal(inbox.length, 120, "drafts and out-of-window mail are skipped");
    assert.deepEqual(all.pages.slice(0, 2).map((p) => p.messages.length), [50, 20]);

    const byId = new Map(all.messages.map((m) => [m.messageIdHeader, m]));
    assert.deepEqual(first.messages[0]!.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.equal(first.messages[0]!.unread, false);
    assert.equal(first.messages[0]!.starred, true);
    assert.equal(first.messages[1]!.unread, true);
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
    noLocksLeft(r);
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

  it("resumes the first sync from the cursor after a restart", async () => {
    const s = genericServer();
    for (let i = 0; i < 120; i++) s.deliver("INBOX", mail({ id: `m${i}` }));
    const r1 = rig(s);
    const p1 = await r1.provider.sync(null);
    assert.equal(p1.messages.length, 50);

    const r2 = rig(s); // a new provider has no in-memory queue
    const rest = await drain(r2.provider, p1.cursor);
    assert.deepEqual(rest.messages.map((m) => m.remoteId).slice(0, 2), ["INBOX:1:51", "INBOX:1:52"]);
    assert.equal(rest.messages.length, 70);
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
    assert.equal(s.find("INBOX", 1)!.flags.size, 0);
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
    const att = st.messages[0]!.attachments[0]!;
    assert.equal(att.remoteId, "idx:0");
    assert.equal(att.content, undefined, "bytes stay on the server until asked for");
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
