/**
 * ImapProvider pages ingested into a real MailStore: what a user sees after moves between mailboxes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Db } from "../src/db/index.ts";
import { MailStore, type AccountRow } from "../src/mail/store.ts";
import { ImapProvider, type ImapSettings } from "../src/providers/imap.ts";
import { FakeServer } from "./fake-imap.ts";

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

function mail(id: string, extra: { inReplyTo?: string } = {}): string {
  return [
    `Message-ID: <${id}@example.com>`,
    "From: Alice <alice@example.com>",
    "To: me@example.com",
    `Subject: Subject ${id}`,
    `Date: ${new Date().toUTCString()}`,
    extra.inReplyTo ? `In-Reply-To: <${extra.inReplyTo}@example.com>` : undefined,
    "",
    `Body of ${id}`,
    "",
  ]
    .filter((l) => l !== undefined)
    .join("\r\n");
}

describe("ImapProvider into a MailStore", () => {
  let dir: string;
  let n = 0;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "slipstream-imap-store-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function world(server: FakeServer, imapHost = "imap.example.com") {
    const db = new Db(join(dir, `db${n++}.sqlite`));
    db.run("INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'me@example.com', 'Me', 1)");
    db.run("INSERT INTO accounts (id, user_id, provider, email, name, created_at) VALUES ('a1', 'u1', 'imap', 'me@example.com', 'Me', 1)");
    const account = db.get<AccountRow>("SELECT * FROM accounts WHERE id = 'a1'")!;
    const store = new MailStore(db, join(dir, `data${n}`));
    const provider = new ImapProvider(
      { accountId: "a1", email: "me@example.com", auth: { ...SETTINGS, imapHost }, saveAuth() {}, initialSyncDays: 30 },
      { createClient: () => server.connect().asClient() },
    );
    let cursor: string | null = null;
    const sync = async () => {
      for (let i = 0; i < 100; i++) {
        const page = await provider.sync(cursor);
        store.ingest(account, page);
        cursor = page.cursor;
        if (page.done) return;
      }
      throw new Error("sync did not finish");
    };
    return { db, store, provider, sync };
  }

  const thread = (id: string) => ({ threadRemoteId: "t", messages: [{ remoteId: "stale:1:1", messageIdHeader: `<${id}@example.com>` }] });

  it("keeps a message that was archived (generic IMAP)", async () => {
    const s = new FakeServer();
    s.add("INBOX", "\\Inbox");
    s.add("Archive", "\\Archive");
    s.deliver("INBOX", mail("a"));
    const w = world(s);
    await w.sync();
    await w.sync();

    await w.provider.apply({ kind: "archive", ...thread("a") });
    await w.sync();
    const rows = w.db.all<{ remote_id: string; in_inbox: number }>("SELECT remote_id, in_inbox FROM messages");
    assert.deepEqual(rows.map((r) => [r.remote_id, r.in_inbox]), [["Archive:1:1", 0]]);
    assert.equal(w.db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads")!.in_inbox, 0);
    w.db.close();
  });

  it("keeps the thread, and what was set on it, when its mail moves (generic IMAP)", async () => {
    const s = new FakeServer();
    s.add("INBOX", "\\Inbox");
    s.add("Archive", "\\Archive");
    s.deliver("INBOX", mail("a"));
    const w = world(s);
    await w.sync();
    await w.sync();
    const before = w.db.get<{ id: string }>("SELECT id FROM threads")!.id;
    // Snooze, as the app does: set locally, then push an archive.
    w.db.run("UPDATE threads SET in_inbox = 0, snoozed_until = ? WHERE id = ?", Date.now() + 3_600_000, before);

    await w.provider.apply({ kind: "archive", ...thread("a") });
    await w.sync();
    const after = w.db.get<{ id: string; snoozed_until: number | null }>("SELECT id, snoozed_until FROM threads")!;
    assert.equal(after.id, before);
    assert.ok(after.snoozed_until, "the reminder survived");
    w.db.close();
  });

  it("retires Gmail's old copy beyond the change window, without losing the thread", async () => {
    const s = new FakeServer({ capabilities: ["IMAP4rev1", "UIDPLUS", "MOVE", "X-GM-EXT-1"], condstore: true });
    s.add("INBOX", "\\Inbox");
    s.add("[Gmail]/All Mail", "\\All");
    s.add("[Gmail]/Trash", "\\Trash");
    s.add("[Gmail]/Spam", "\\Junk");
    s.deliver("[Gmail]/All Mail", mail("oldest"), { labels: ["\\Inbox"], threadId: "t-oldest" });
    for (let i = 0; i < 520; i++) s.deliver("[Gmail]/All Mail", mail(`m${i}`), { labels: ["\\Inbox"], threadId: `t${i}` });
    const w = world(s, "imap.gmail.com");
    await w.sync();
    await w.sync();
    assert.equal(w.db.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n, 521);
    const thread0 = w.db.get<{ id: string }>("SELECT t.id FROM threads t JOIN messages m ON m.thread_id = t.id WHERE m.message_id_header = '<oldest@example.com>'")!.id;

    await w.provider.apply({ kind: "trash", ...thread("oldest") });
    await w.sync();

    const rows = w.db.all<{ remote_id: string; in_trash: number; thread_id: string }>(
      "SELECT remote_id, in_trash, thread_id FROM messages WHERE message_id_header = '<oldest@example.com>'",
    );
    assert.deepEqual(rows.map((r) => [r.remote_id, r.in_trash]), [["[Gmail]/Trash:1:1", 1]], "the All Mail row is gone");
    assert.equal(rows[0]!.thread_id, thread0, "same thread throughout");
    assert.equal(w.db.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n, 521);
    w.db.close();
  });
});
