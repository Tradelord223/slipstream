import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Db } from "../src/db/index.ts";
import { parseTakeoutLabels, readMailFile, takeoutState } from "../src/import/mailfile.ts";
import { MailStore, type AccountRow } from "../src/mail/store.ts";
import type { IncomingMessage } from "../src/mail/types.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "latin1");

const sep = (n: number) => `From ${n}@xxx Mon Mar 02 10:00:00 +0000 2026`;

function mbox(): string {
  return [
    sep(1),
    "Message-ID: <m1@example.com>",
    "From: Alice Park <alice@example.com>",
    "To: Me <me@example.com>",
    "Subject: Quarterly plan",
    "Date: Mon, 02 Mar 2026 10:00:00 +0000",
    'X-Gmail-Labels: Inbox,Unread,Starred,Clients,Opened,"Category Promotions",Important',
    "",
    "Can you review the quarterly plan?",
    "",
    sep(2),
    "Message-ID: <m2@example.com>",
    "In-Reply-To: <m1@example.com>",
    "References: <m1@example.com>",
    "From: Me <me@example.com>",
    "To: Alice Park <alice@example.com>",
    "Subject: Re: Quarterly plan",
    "Date: Mon, 02 Mar 2026 11:00:00 +0000",
    "X-Gmail-Labels: Sent",
    "",
    "Looks good to me.",
    "",
    sep(3),
    "Message-ID: <m3@example.com>",
    "From: Bob <bob@example.com>",
    "To: me@example.com",
    "Subject: Standup",
    "Date: Tue, 03 Mar 2026 09:00:00 +0000",
    'X-Gmail-Labels: Inbox,"Big, Clients"',
    "X-GM-THRID: 1789",
    "",
    "Hello team,",
    "",
    ">From here on we meet weekly.",
    ">>From a quoted reply: stays quoted once.",
    "",
    sep(4),
    "Message-ID: <m4@example.com>",
    "From: Carol <carol@example.com>",
    "To: me@example.com",
    "Subject: Invoice",
    "Date: Wed, 04 Mar 2026 09:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Invoice attached.",
    "--b1",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    PDF.toString("base64"),
    "--b1--",
    "",
  ].join("\n");
}

const EML = [
  "Message-ID: <solo@example.com>",
  "From: Dana <dana@example.com>",
  "To: me@example.com",
  "Subject: Single message",
  "Date: Thu, 05 Mar 2026 09:00:00 +0000",
  "",
  "Just one message.",
  "",
].join("\r\n");

async function collect(path: string, name: string, self?: string): Promise<IncomingMessage[]> {
  const out: IncomingMessage[] = [];
  for await (const m of readMailFile(path, name, self)) out.push(m);
  return out;
}

describe("Takeout labels", () => {
  it("splits on commas outside quotes", () => {
    assert.deepEqual(parseTakeoutLabels('Inbox,"Big, Clients",Unread, Plain ,"Say \\"hi\\""'), [
      "Inbox",
      "Big, Clients",
      "Unread",
      "Plain",
      'Say "hi"',
    ]);
  });

  it("maps system labels to folders and flags", () => {
    const s = takeoutState(["Inbox", "Unread", "Starred", "Clients", "Opened", "Important", "Category Updates", "Trash"]);
    assert.deepEqual(s.folders, { inbox: true, sent: false, trash: true, spam: false });
    assert.equal(s.unread, true);
    assert.equal(s.starred, true);
    assert.deepEqual(s.labels, [{ remoteId: "takeout:Clients", name: "Clients" }]);
  });
});

describe("mail file import", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "slipstream-import-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a Takeout mbox", async () => {
    const path = join(dir, "takeout.mbox");
    writeFileSync(path, mbox());
    const msgs = await collect(path, "takeout.mbox");
    assert.equal(msgs.length, 4);
    const [m1, m2, m3, m4] = msgs as [IncomingMessage, IncomingMessage, IncomingMessage, IncomingMessage];

    assert.equal(m1.remoteId, "import:<m1@example.com>");
    assert.equal(m1.subject, "Quarterly plan");
    assert.equal(m1.from.email, "alice@example.com");
    assert.equal(m1.unread, true);
    assert.equal(m1.starred, true);
    assert.deepEqual(m1.folders, { inbox: true, sent: false, trash: false, spam: false });
    assert.deepEqual(m1.labels, [{ remoteId: "takeout:Clients", name: "Clients" }]);
    assert.ok(!m1.outgoing, "no owner address was known yet");

    assert.equal(m2.inReplyTo, "<m1@example.com>");
    assert.deepEqual(m2.references, ["<m1@example.com>"]);
    assert.equal(m2.folders.sent, true);
    assert.equal(m2.outgoing, true);
    assert.equal(m2.unread, false);
    assert.deepEqual(m2.labels, []);

    assert.deepEqual(m3.labels, [{ remoteId: "takeout:Big, Clients", name: "Big, Clients" }]);
    assert.equal(m3.remoteThreadId, "1789");
    assert.match(m3.bodyText, /\nFrom here on we meet weekly\./);
    assert.match(m3.bodyText, /\n>From a quoted reply/);
    assert.ok(!/>From here on/.test(m3.bodyText));

    assert.deepEqual(m4.folders, { inbox: false, sent: false, trash: false, spam: false });
    assert.equal(m4.unread, false);
    assert.equal(m4.attachments.length, 1);
    assert.equal(m4.attachments[0]!.filename, "invoice.pdf");
    assert.equal(m4.attachments[0]!.mimeType, "application/pdf");
    assert.ok(m4.attachments[0]!.content?.equals(PDF));
  });

  it("keeps CRLF files intact and detects mbox by content, not extension", async () => {
    const path = join(dir, "crlf.txt");
    writeFileSync(path, mbox().replace(/\n/g, "\r\n"));
    const msgs = await collect(path, "crlf.txt", "me@example.com");
    assert.equal(msgs.length, 4);
    assert.match(msgs[2]!.bodyText, /From here on we meet weekly\./);
    assert.ok(msgs[3]!.attachments[0]!.content?.equals(PDF));
    assert.equal(msgs[1]!.outgoing, true);
    assert.equal(msgs[0]!.outgoing, false);
  });

  it("reads a single .eml", async () => {
    const path = join(dir, "one.eml");
    writeFileSync(path, EML);
    const msgs = await collect(path, "one.eml");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.remoteId, "import:<solo@example.com>");
    assert.equal(msgs[0]!.subject, "Single message");
    assert.equal(msgs[0]!.bodyText.trim(), "Just one message.");
    assert.deepEqual(msgs[0]!.folders, { inbox: false, sent: false, trash: false, spam: false });
    assert.equal(msgs[0]!.unread, false);
  });

  it("falls back to a content hash when there is no Message-ID", async () => {
    const path = join(dir, "noid.eml");
    writeFileSync(path, "From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n");
    const [m] = await collect(path, "noid.eml");
    assert.match(m!.remoteId, /^import:[0-9a-f]{64}$/);
  });

  it("rejects files that aren't mail", async () => {
    const path = join(dir, "photo.eml");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
    await assert.rejects(collect(path, "photo.eml"), /doesn't look like an email/);
    const empty = join(dir, "empty.mbox");
    writeFileSync(empty, "");
    await assert.rejects(collect(empty, "empty.mbox"), /empty/);
  });

  it("ingests into a real store: threads the reply with its parent and searches unescaped text", async () => {
    const mboxPath = join(dir, "store.mbox");
    writeFileSync(mboxPath, mbox());
    const emlPath = join(dir, "store.eml");
    writeFileSync(emlPath, EML);

    const db = new Db(join(dir, "test.db"));
    try {
      db.run("INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'me@example.com', 'Me', 1)");
      db.run(
        "INSERT INTO accounts (id, user_id, provider, email, name, created_at) VALUES ('a1', 'u1', 'archive', 'me@example.com', 'Imported', 1)",
      );
      const account = db.get<AccountRow>("SELECT * FROM accounts WHERE id = 'a1'")!;
      const store = new MailStore(db, join(dir, "data"));

      const messages = [...(await collect(mboxPath, "store.mbox")), ...(await collect(emlPath, "store.eml"))];
      store.ingest(account, { messages, cursor: "archive", done: true });

      const rows = db.all<{ subject: string; message_count: number; in_inbox: number; unread_count: number; starred: number }>(
        "SELECT subject, message_count, in_inbox, unread_count, starred FROM threads ORDER BY subject",
      );
      assert.equal(rows.length, 4, "five messages in four threads");
      const plan = rows.find((r) => r.subject === "Quarterly plan")!;
      assert.equal(plan.message_count, 2, "the Sent reply joins its parent's thread");
      assert.equal(plan.in_inbox, 1);
      assert.equal(plan.unread_count, 1);
      assert.equal(plan.starred, 1);

      const hit = db.all<{ subject: string }>(
        `SELECT m.subject FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH '"weekly"'`,
      );
      assert.deepEqual(hit.map((h) => h.subject), ["Standup"]);
      const stored = db.get<{ body_text: string }>("SELECT body_text FROM messages WHERE message_id_header = '<m3@example.com>'")!;
      assert.match(stored.body_text, /\nFrom here on we meet weekly\./);

      const labels = db.all<{ name: string }>("SELECT name FROM labels ORDER BY name");
      assert.deepEqual(labels.map((l) => l.name), ["Big, Clients", "Clients"]);

      const att = db.get<{ blob_sha256: string; filename: string }>("SELECT blob_sha256, filename FROM attachments")!;
      assert.equal(att.filename, "invoice.pdf");
      assert.ok(store.readBlob(att.blob_sha256)?.equals(PDF));

      // Importing the same file again is a no-op.
      store.ingest(account, { messages: await collect(mboxPath, "store.mbox"), cursor: "archive", done: true });
      assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n, 5);
    } finally {
      db.close();
    }
  });

  it("streams a large mbox without loading it", { timeout: 120_000 }, async () => {
    const path = join(dir, "big.mbox");
    const out = createWriteStream(path);
    const total = 5000;
    const body = "Lorem ipsum dolor sit amet. ".repeat(40);
    for (let i = 0; i < total; i++) {
      const chunk = [
        sep(i),
        `Message-ID: <gen${i}@example.com>`,
        `From: Sender ${i} <s${i}@example.com>`,
        "To: me@example.com",
        `Subject: Generated ${i}`,
        "Date: Mon, 02 Mar 2026 10:00:00 +0000",
        "X-Gmail-Labels: Inbox",
        "",
        body,
        i % 7 === 0 ? ">From the archive" : "",
        "",
        "",
      ].join("\n");
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");

    const heapBefore = process.memoryUsage().heapUsed;
    let count = 0;
    let last: IncomingMessage | undefined;
    for await (const m of readMailFile(path, "big.mbox")) {
      count++;
      last = m;
    }
    assert.equal(count, total);
    assert.equal(last!.subject, `Generated ${total - 1}`);
    assert.ok(process.memoryUsage().heapUsed - heapBefore < 150 * 1024 * 1024, "heap stayed bounded");
  });
});
