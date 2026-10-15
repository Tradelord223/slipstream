/**
 * ImapProvider through the real imapflow client, against an in-process IMAP server (see mini-imap.ts).
 * Proves the provider's use of imapflow (ranges, search compilation, literals, CONDSTORE, Gmail extensions) rather
 * than just its own logic. It is not a substitute for a test against Gmail, iCloud, Fastmail and friends.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ImapFlow } from "imapflow";
import { ProviderAuthError, type SyncPage } from "../src/mail/types.ts";
import { ImapProvider, parseCursor, verifyImap, type ImapDeps, type ImapSettings } from "../src/providers/imap.ts";
import { FakeServer, type FakeOptions } from "./fake-imap.ts";
import { startMiniImap, type MiniImap } from "./mini-imap.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "latin1");

function mail(id: string, extra: { from?: string; subject?: string } = {}): string {
  return [
    `Message-ID: <${id}@example.com>`,
    `From: ${extra.from ?? "Alice <alice@example.com>"}`,
    "To: me@example.com",
    `Subject: ${extra.subject ?? `Subject ${id}`}`,
    `Date: ${new Date().toUTCString()}`,
    "",
    `Body of ${id}`,
    "",
  ].join("\r\n");
}

const open: MiniImap[] = [];
const providers: ImapProvider[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.close().catch(() => {});
  for (const s of open.splice(0)) await s.close();
});

async function start(data: FakeServer, password = "pw", deps: Pick<ImapDeps, "createTransport"> = {}) {
  const mini = await startMiniImap(data);
  open.push(mini);
  const provider = new ImapProvider(
    {
      accountId: "acc",
      email: "me@example.com",
      auth: { username: "me@example.com", password, imapHost: "127.0.0.1", imapPort: mini.port, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false } satisfies ImapSettings,
      saveAuth() {},
      initialSyncDays: 30,
    },
    {
      createClient: () =>
        new ImapFlow({
          host: "127.0.0.1",
          port: mini.port,
          secure: false,
          doSTARTTLS: false,
          auth: { user: "me@example.com", pass: password },
          logger: false,
          disableAutoIdle: true,
        }),
      ...deps,
    },
  );
  providers.push(provider);
  return { mini, provider };
}

function generic(opts?: FakeOptions): FakeServer {
  const s = new FakeServer(opts);
  s.add("INBOX", "\\Inbox");
  s.add("Sent", "\\Sent");
  s.add("Trash", "\\Trash");
  s.add("Junk", "\\Junk");
  return s;
}

async function drain(p: ImapProvider, cursor: string | null) {
  const pages: SyncPage[] = [];
  for (let i = 0; i < 100; i++) {
    const page = await p.sync(cursor);
    pages.push(page);
    cursor = page.cursor;
    if (page.done) break;
  }
  assert.equal(pages.at(-1)!.done, true);
  return {
    pages,
    cursor,
    messages: pages.flatMap((pg) => pg.messages),
    flags: pages.flatMap((pg) => pg.flagUpdates ?? []),
    deleted: pages.flatMap((pg) => pg.deletedRemoteIds ?? []),
  };
}

const T = (...ids: string[]) => ({
  threadRemoteId: "t",
  messages: ids.map((id) => ({ remoteId: `Stale:1:1`, messageIdHeader: `<${id}@example.com>` })),
});

describe("ImapProvider over a real IMAP connection", () => {
  it("syncs 120 messages in batches and then follows changes", async () => {
    const data = generic();
    for (let i = 0; i < 120; i++) data.deliver("INBOX", mail(`m${i}`), { flags: i === 5 ? ["\\Seen"] : [] });
    data.deliver("Sent", mail("out", { from: "Me <me@example.com>" }), { flags: ["\\Seen"] });
    const { provider } = await start(data);

    let st = await drain(provider, null);
    assert.equal(st.messages.length, 121);
    assert.deepEqual(st.pages.filter((p) => p.messages.length).map((p) => p.messages.length), [50, 50, 20, 1]);
    const m5 = st.messages.find((m) => m.messageIdHeader === "<m5@example.com>")!;
    assert.equal(m5.remoteId, "INBOX:1:6");
    assert.equal(m5.unread, false);
    assert.equal(m5.subject, "Subject m5");
    assert.equal(m5.bodyText.trim(), "Body of m5");
    assert.equal(st.messages.at(-1)!.outgoing, true);

    st = await drain(provider, st.cursor); // seed
    data.deliver("INBOX", mail("fresh"));
    data.change("INBOX", 1, (m) => m.flags.add("\\Seen").add("\\Flagged"));
    data.expunge("INBOX", 2);
    st = await drain(provider, st.cursor);
    assert.deepEqual(st.messages.map((m) => m.remoteId), ["INBOX:1:121"]);
    assert.deepEqual(st.flags, [{ remoteId: "INBOX:1:1", unread: false, starred: true }]);
    assert.deepEqual(st.deleted, ["INBOX:1:2"]);

    st = await drain(provider, st.cursor);
    assert.deepEqual([st.messages.length, st.flags.length, st.deleted.length], [0, 0, 0]);
  });

  it("uses CONDSTORE's CHANGEDSINCE", async () => {
    const data = generic({ condstore: true });
    data.deliver("INBOX", mail("a"));
    data.deliver("INBOX", mail("b"));
    const { provider } = await start(data);
    let st = await drain(provider, null);
    assert.ok(parseCursor(st.cursor).boxes["INBOX"]!.highestModseq);
    st = await drain(provider, st.cursor);
    assert.equal(st.flags.length, 0);

    data.change("INBOX", 2, (m) => m.flags.add("\\Seen"));
    st = await drain(provider, st.cursor);
    assert.deepEqual(st.flags, [{ remoteId: "INBOX:1:2", unread: false, starred: false }]);
    st = await drain(provider, st.cursor);
    assert.equal(st.flags.length, 0);
  });

  it("applies triage actions with MOVE, STORE and header searches", async () => {
    const data = generic();
    for (const id of ["a", "b", "c"]) data.deliver("INBOX", mail(id));
    const { provider } = await start(data);

    await provider.apply({ kind: "markRead", ...T("a", "b") });
    await provider.apply({ kind: "star", ...T("a") });
    assert.deepEqual([...data.find("INBOX", 1)!.flags].sort(), ["\\Flagged", "\\Seen"]);
    assert.deepEqual([...data.find("INBOX", 2)!.flags], ["\\Seen"]);
    assert.equal(data.find("INBOX", 3)!.flags.size, 0);

    await provider.apply({ kind: "archive", ...T("a", "b") });
    assert.deepEqual(data.ids("Archive"), ["<a@example.com>", "<b@example.com>"]);
    assert.deepEqual(data.ids("INBOX"), ["<c@example.com>"]);

    await provider.apply({ kind: "unarchive", ...T("a") });
    assert.deepEqual(data.ids("INBOX").sort(), ["<a@example.com>", "<c@example.com>"]);

    await provider.apply({ kind: "trash", ...T("a", "c") });
    assert.deepEqual(data.ids("Trash").sort(), ["<a@example.com>", "<c@example.com>"]);
    await provider.apply({ kind: "untrash", ...T("c") });
    await provider.apply({ kind: "spam", ...T("c") });
    assert.deepEqual(data.ids("Junk"), ["<c@example.com>"]);

    await provider.apply({ kind: "addLabel", label: { remoteId: "x", name: "Big Clients" }, ...T("c") });
    assert.ok(data.find("Junk", 1)!.flags.has("Big_Clients"));
  });

  it("finds many Message-IDs with one OR search", async () => {
    const data = generic();
    const ids = Array.from({ length: 25 }, (_, i) => `t${i}`);
    for (const id of ids) data.deliver("INBOX", mail(id));
    data.deliver("INBOX", mail("bystander"));
    const { provider } = await start(data);
    await provider.apply({ kind: "trash", ...T(...ids) });
    assert.equal(data.ids("Trash").length, 25);
    assert.deepEqual(data.ids("INBOX"), ["<bystander@example.com>"]);
  });

  it("files a sent message with APPEND, literal and all", async () => {
    const data = generic();
    const { provider } = await start(data, "pw", { createTransport: () => ({ sendMail: async () => ({}), close() {} }) as never });
    const raw = Buffer.from(["Message-ID: <s1@example.com>", "From: Me <me@example.com>", "To: a@example.com", "Bcc: hidden@example.com", "Subject: Hi", "", "line one", "line two", ""].join("\r\n"));
    await provider.apply({
      kind: "send",
      message: {
        from: { name: "Me", email: "me@example.com" },
        to: [{ name: "", email: "a@example.com" }],
        cc: [],
        bcc: [{ name: "", email: "hidden@example.com" }],
        subject: "Hi",
        html: "",
        text: "",
        raw,
        messageIdHeader: "<s1@example.com>",
      },
    });
    assert.equal(data.appended.length, 1);
    assert.equal(data.appended[0]!.path, "Sent");
    assert.deepEqual(data.appended[0]!.flags, ["\\Seen"]);
    assert.ok(data.appended[0]!.raw.equals(raw));
    assert.equal(data.ids("Sent")[0], "<s1@example.com>");
  });

  it("downloads attachments", async () => {
    const data = generic();
    const raw = [
      "Message-ID: <att@example.com>",
      "From: Carol <carol@example.com>",
      "To: me@example.com",
      "Subject: Invoice",
      `Date: ${new Date().toUTCString()}`,
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
    data.deliver("INBOX", raw);
    const { provider } = await start(data);
    const st = await drain(provider, null);
    assert.equal(st.messages[0]!.attachments[0]!.filename, "invoice.pdf");
    const bytes = await provider.fetchAttachment(st.messages[0]!.remoteId, st.messages[0]!.attachments[0]!.remoteId!);
    assert.ok(bytes.equals(PDF));
  });

  it("reconnects after the server hangs up", async () => {
    const data = generic();
    data.deliver("INBOX", mail("a"));
    const { provider, mini } = await start(data);
    let st = await drain(provider, null);
    mini.dropAll();
    await new Promise((r) => setTimeout(r, 50));
    data.deliver("INBOX", mail("b"));
    st = await drain(provider, st.cursor);
    assert.deepEqual(st.messages.map((m) => m.messageIdHeader), ["<b@example.com>"]);
    assert.equal(mini.commands.filter((c) => c.startsWith("LOGIN")).length, 2);
  });

  it("reports a wrong password as ProviderAuthError", async () => {
    const { provider } = await start(generic(), "wrong");
    await assert.rejects(provider.sync(null), (err: Error) => err instanceof ProviderAuthError && /rejected the IMAP sign-in/.test(err.message));
  });

  it("verifyImap won't send a password to a server that can't upgrade to TLS", async () => {
    const mini = await startMiniImap(generic());
    open.push(mini);
    await assert.rejects(
      verifyImap({ username: "me@example.com", password: "pw", imapHost: "127.0.0.1", imapPort: mini.port, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false }),
      /encrypted \(STARTTLS\)/,
    );
    assert.ok(!mini.commands.some((c) => c.startsWith("LOGIN")), "the password never crossed the wire");
  });

  it("verifyImap names the problem when nothing is listening", async () => {
    await assert.rejects(
      verifyImap({ username: "u", password: "p", imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false }),
      /refused the IMAP connection/,
    );
  });
});

describe("ImapProvider over a real connection (Gmail extensions)", () => {
  function gmail(): FakeServer {
    const s = new FakeServer({ capabilities: ["IMAP4rev1", "UIDPLUS", "MOVE", "X-GM-EXT-1"], condstore: true });
    s.add("INBOX", "\\Inbox");
    s.add("[Gmail]/All Mail", "\\All");
    s.add("[Gmail]/Sent Mail", "\\Sent");
    s.add("[Gmail]/Trash", "\\Trash");
    s.add("[Gmail]/Spam", "\\Junk");
    return s;
  }

  it("reads threads and labels, and relabels on archive", async () => {
    const data = gmail();
    data.deliver("[Gmail]/All Mail", mail("a"), { labels: ["\\Inbox", "Clients", "\\Important"], threadId: "1800" });
    data.deliver("[Gmail]/All Mail", mail("b", { from: "Me <me@example.com>" }), { labels: ["\\Sent"], threadId: "1800", flags: ["\\Seen"] });
    const { provider } = await start(data);

    let st = await drain(provider, null);
    const a = st.messages.find((m) => m.messageIdHeader === "<a@example.com>")!;
    assert.equal(a.remoteThreadId, "1800");
    assert.deepEqual(a.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.deepEqual(a.labels, [{ remoteId: "Clients", name: "Clients" }]);
    assert.equal(st.messages.find((m) => m.messageIdHeader === "<b@example.com>")!.folders.sent, true);

    st = await drain(provider, st.cursor);
    await provider.apply({ kind: "archive", ...T("a") });
    assert.equal(data.find("[Gmail]/All Mail", 1)!.labels!.has("\\Inbox"), false);
    assert.equal(data.find("[Gmail]/All Mail", 1)!.labels!.has("Clients"), true);
    st = await drain(provider, st.cursor);
    assert.equal(st.flags.length, 1);
    assert.equal(st.flags[0]!.folders?.inbox, false);

    await provider.apply({ kind: "addLabel", label: { remoteId: "Receipts", name: "Receipts" }, ...T("a") });
    assert.equal(data.find("[Gmail]/All Mail", 1)!.labels!.has("Receipts"), true);
    await provider.apply({ kind: "trash", ...T("a") });
    assert.equal(data.ids("[Gmail]/Trash").length, 1);
  });
});
