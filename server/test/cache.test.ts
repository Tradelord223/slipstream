import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { runDoctor } from "../src/doctor.ts";
import { sha256 } from "../src/lib/crypto.ts";
import { cacheUsage, vacuumInBackground, type Query } from "../src/mail/cache.ts";
import type { AccountRow } from "../src/mail/store.ts";
import type { FullBody, MailProvider } from "../src/mail/types.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";

/**
 * The cache of full message text: how big it is, who goes first when it is over its limit, what is never evicted, when an
 * attachment file may go, and the one-time trim of an install that grew under the old download-everything sync.
 */

const DAY = 86_400_000;
const envs: TestEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) {
    e.ctx.sync.cache.stop();
    e.cleanup();
  }
});

const ana = { name: "Ana Okoye", email: "ana@fernpoint.test" };
const row = <T,>(env: TestEnv, sql: string, ...p: (string | number)[]) => env.ctx.db.get<T>(sql, ...p)!;

function rig() {
  const env = makeEnv();
  envs.push(env);
  const accountId = addAccount(env.ctx, LOCAL_USER_ID, "me@fernpoint.test", "imap");
  const account = row<AccountRow>(env, "SELECT * FROM accounts WHERE id = ?", accountId);
  const query: Query = (sql, ...p) => env.ctx.db.all(sql, ...p);
  return { env, accountId, account, query, cache: env.ctx.sync.cache };
}
type Rig = ReturnType<typeof rig>;

interface Put {
  remoteId: string;
  /** Bytes of plain text; the text is ASCII, so this is also its length. */
  bytes?: number;
  sentAt?: number;
  inbox?: boolean;
  viewedAt?: number | null;
  attachment?: Buffer;
  account?: AccountRow;
  text?: string;
}

/** A message stored whole, the way a full download or a mail sent from here is. */
function put(r: Rig, o: Put): string {
  const body = o.text ?? "x".repeat(o.bytes ?? 100_000);
  r.env.ctx.store.ingest(o.account ?? r.account, {
    messages: [
      msg({
        remoteId: o.remoteId,
        from: ana,
        remoteThreadId: `th-${o.remoteId}`,
        bodyText: body,
        sentAt: o.sentAt ?? Date.now() - DAY,
        folders: { inbox: o.inbox ?? false, sent: false, trash: false, spam: false },
        attachments: o.attachment ? [{ filename: "report.pdf", mimeType: "application/pdf", size: o.attachment.length, inline: false, content: o.attachment }] : [],
      }),
    ],
    cursor: null,
    done: false,
  });
  const id = row<{ id: string }>(r.env, "SELECT id FROM messages WHERE remote_id = ? AND account_id = ?", o.remoteId, (o.account ?? r.account).id).id;
  if (o.viewedAt !== undefined) r.env.ctx.db.run("UPDATE messages SET last_viewed_at = ? WHERE id = ?", o.viewedAt, id);
  return id;
}

const limitMb = (r: Rig, mb: number) =>
  r.env.ctx.db.run("INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, 'cacheLimitMb', ?)", LOCAL_USER_ID, JSON.stringify(mb));
const state = (r: Rig, remoteId: string) => row<{ body_state: string }>(r.env, "SELECT body_state FROM messages WHERE remote_id = ?", remoteId).body_state;
const states = (r: Rig, ids: string[]) => ids.map((id) => state(r, id));
const blobPath = (r: Rig, bytes: Buffer) => join(r.env.ctx.store.blobDir, sha256(bytes).slice(0, 2), sha256(bytes));
const search = async (env: TestEnv, q: string) =>
  ((await (await env.api(`/api/threads?view=search&q=${encodeURIComponent(q)}`)).json()) as { threads: { id: string }[] }).threads.length;

describe("cache size", () => {
  test("counts bytes rather than characters, a message without HTML, and only the files messages alone use", () => {
    const r = rig();
    put(r, { remoteId: "plain", text: "é".repeat(1000) });
    const pdf = Buffer.from("%PDF-1.4 ".repeat(500));
    put(r, { remoteId: "withfile", text: "x".repeat(300), attachment: pdf });
    const shared = Buffer.from("also on a draft ".repeat(100));
    put(r, { remoteId: "withdraftfile", text: "x".repeat(200), attachment: shared });
    r.env.ctx.db.run("INSERT INTO drafts (id, user_id, account_id, status, updated_at) VALUES ('drf_1', ?, ?, 'draft', 0)", LOCAL_USER_ID, r.accountId);
    r.env.ctx.db.run(
      "INSERT INTO draft_attachments (id, draft_id, filename, mime_type, size, blob_sha256) VALUES ('da_1', 'drf_1', 'a.pdf', 'application/pdf', ?, ?)",
      shared.length,
      sha256(shared),
    );
    r.env.ctx.db.run("UPDATE messages SET body_html = ? WHERE remote_id = 'withfile'", "<p>".padEnd(700, "y"));

    const usage = r.cache.usage(LOCAL_USER_ID);
    assert.equal(usage.messages, 3);
    assert.equal(usage.bodies, 2000 + (300 + 700) + 200, "é is two bytes; a missing HTML column adds nothing and doesn't hide the row");
    assert.equal(usage.blobs, pdf.length, "the file a draft also uses is the draft's, not the cache's");
    assert.equal(usage.total, usage.bodies + usage.blobs);
  });

  test("leaves out summaries and what can't be fetched again", () => {
    const r = rig();
    put(r, { remoteId: "whole", bytes: 1000 });
    r.env.ctx.store.ingest(r.account, { messages: [msg({ remoteId: "sum", from: ana, bodyText: "preview", bodyComplete: false })], cursor: null, done: false });
    put(r, { remoteId: "sent:<abc@x>", bytes: 5000 });
    put(r, { remoteId: "local:1", bytes: 5000 });
    const archive = row<AccountRow>(r.env, "SELECT * FROM accounts WHERE id = ?", addAccount(r.env.ctx, LOCAL_USER_ID, "import@fernpoint.test", "archive"));
    put(r, { remoteId: "imported", bytes: 5000, account: archive });
    assert.equal(r.cache.usage(LOCAL_USER_ID).bodies, 1000);
  });

  test("the setting is validated and used", async () => {
    const r = rig();
    assert.equal((await r.env.api("/api/settings", { method: "PUT", json: { cacheLimitMb: 5 } })).status, 400);
    assert.equal((await r.env.api("/api/settings", { method: "PUT", json: { cacheLimitMb: "lots" } })).status, 400);
    assert.equal((await r.env.api("/api/settings", { method: "PUT", json: { cacheLimitMb: 250 } })).status, 200);
    const { limitBytes } = await import("../src/mail/cache.ts");
    assert.equal(limitBytes(r.query, LOCAL_USER_ID), 250 * 1024 * 1024);
    r.env.ctx.db.run("DELETE FROM settings WHERE key = 'cacheLimitMb'");
    assert.equal(limitBytes(r.query, LOCAL_USER_ID), 100 * 1024 * 1024, "100 MB when nobody chose");
    assert.equal(cacheUsage(r.query, r.env.ctx.store.blobDir, LOCAL_USER_ID).total, 0);
  });
});

describe("eviction", () => {
  test("least recently read goes first, by the day it was read or else the day it was sent, and stops below the limit", () => {
    const r = rig();
    const now = Date.now();
    // a: read just now. c: read an hour ago. The rest were never opened. Oldest first: b, d, e, f, then c, then a.
    for (const [k, name] of ["a", "b", "c", "d", "e", "f"].entries()) {
      put(r, { remoteId: name, bytes: 100_000, sentAt: now - (9 - k) * DAY, viewedAt: name === "a" ? now : name === "c" ? now - 3_600_000 : null });
    }
    limitMb(r, 0.4);
    assert.equal(r.cache.enforce(), 3);
    assert.deepEqual(states(r, ["a", "b", "c", "d", "e", "f"]), ["cached", "none", "cached", "none", "none", "cached"]);
    assert.ok(r.cache.usage(LOCAL_USER_ID).total <= 0.4 * 1024 * 1024 * 0.9);
    assert.equal(r.cache.enforce(), 0, "under the limit, nothing more goes");
  });

  test("an evicted message is a summary again: preview as its text, no HTML, search keeps the preview but not the rest", async () => {
    const r = rig();
    const text = `Your parcel is on its way. ${"filler ".repeat(300)} zebracrossing`;
    const id = put(r, { remoteId: "old", text, sentAt: Date.now() - 20 * DAY });
    r.env.ctx.db.run("UPDATE messages SET body_html = '<p>html</p>' WHERE id = ?", id);
    assert.equal(await search(r.env, "zebracrossing"), 1);
    limitMb(r, 0.001);
    r.cache.enforce();
    const m = row<{ body_state: string; body_text: string; body_html: string | null; snippet: string }>(r.env, "SELECT body_state, body_text, body_html, snippet FROM messages WHERE id = ?", id);
    assert.equal(m.body_state, "none");
    assert.equal(m.body_html, null);
    assert.equal(m.body_text, m.snippet);
    assert.match(m.snippet, /^Your parcel is on its way/);
    assert.equal(await search(r.env, "parcel"), 1, "the preview is still indexed");
    assert.equal(await search(r.env, "zebracrossing"), 0, "the rest of the text no longer is");
  });

  test("the newest 50 inbox messages, mail we sent that hasn't synced back, imports and the demo are never evicted", () => {
    const r = rig();
    const now = Date.now();
    // 60 inbox messages, the 10 oldest are fair game; the archived one is older still and goes first.
    for (let i = 0; i < 60; i++) put(r, { remoteId: `in${i}`, bytes: 10_000, inbox: true, sentAt: now - (100 - i) * 60_000 });
    put(r, { remoteId: "archived", bytes: 10_000, sentAt: now - 30 * DAY });
    put(r, { remoteId: "sent:<mine@x>", bytes: 10_000, sentAt: now - 40 * DAY });
    put(r, { remoteId: "local:1", bytes: 10_000, sentAt: now - 40 * DAY });
    const archive = row<AccountRow>(r.env, "SELECT * FROM accounts WHERE id = ?", addAccount(r.env.ctx, LOCAL_USER_ID, "import@fernpoint.test", "archive"));
    const demo = row<AccountRow>(r.env, "SELECT * FROM accounts WHERE id = ?", addAccount(r.env.ctx, LOCAL_USER_ID, "demo@fernpoint.test", "demo"));
    put(r, { remoteId: "imported", bytes: 10_000, sentAt: now - 50 * DAY, account: archive });
    put(r, { remoteId: "demo1", bytes: 10_000, sentAt: now - 50 * DAY, account: demo });

    limitMb(r, 0.0001);
    r.cache.enforce();
    const evicted = r.env.ctx.db.all<{ remote_id: string }>("SELECT remote_id FROM messages WHERE body_state = 'none' ORDER BY remote_id").map((m) => m.remote_id);
    assert.deepEqual(evicted, ["archived", ...Array.from({ length: 10 }, (_, i) => `in${i}`)].sort());
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages WHERE body_state = 'cached'").n, 50 + 4, "50 inbox messages and the four that can't be fetched again");
  });

  test("a body that was just stored is left alone, so its reader can mark it as read", async () => {
    const r = rig();
    const id = put(r, { remoteId: "old", bytes: 100, sentAt: Date.now() - 90 * DAY });
    r.env.ctx.db.run("UPDATE messages SET body_state = 'none', body_text = 'preview' WHERE id = ?", id);
    const body: FullBody = { text: "x".repeat(200_000), attachments: [] };
    r.env.ctx.sync.provider = () => ({ kind: "imap", sync: async () => ({ messages: [], cursor: null, done: true }), apply: async () => {}, fetchBody: async () => body }) as unknown as MailProvider;
    limitMb(r, 0.01);
    assert.deepEqual((await r.env.ctx.sync.bodies.load([id])).loaded, [id]);
    r.cache.enforce();
    assert.equal(state(r, "old"), "cached", "opening an old message doesn't throw it straight back out");
  });

  test("attachment files go only when nothing else refers to them", () => {
    const r = rig();
    const lonely = Buffer.from("only this message ".repeat(50));
    const onDraft = Buffer.from("also attached to a draft ".repeat(50));
    const onImport = Buffer.from("also in an imported message ".repeat(50));
    const onLogo = Buffer.from("also a sender logo ".repeat(50));
    const archive = row<AccountRow>(r.env, "SELECT * FROM accounts WHERE id = ?", addAccount(r.env.ctx, LOCAL_USER_ID, "import@fernpoint.test", "archive"));
    put(r, { remoteId: "m1", attachment: lonely });
    put(r, { remoteId: "m2", attachment: onDraft });
    put(r, { remoteId: "m3", attachment: onImport });
    put(r, { remoteId: "imp", attachment: onImport, account: archive });
    put(r, { remoteId: "m4", attachment: onLogo });
    r.env.ctx.db.run("INSERT INTO drafts (id, user_id, account_id, status, updated_at) VALUES ('drf_1', ?, ?, 'draft', 0)", LOCAL_USER_ID, r.accountId);
    r.env.ctx.db.run("INSERT INTO draft_attachments (id, draft_id, filename, mime_type, size, blob_sha256) VALUES ('da_1', 'drf_1', 'a', 'x/y', 1, ?)", sha256(onDraft));
    r.env.ctx.db.run("INSERT INTO sender_logos (domain, status, content_type, blob_sha256, fetched_at) VALUES ('logo.test', 'found', 'image/png', ?, 0)", sha256(onLogo));

    limitMb(r, 0.0001);
    r.cache.enforce();
    assert.deepEqual(states(r, ["m1", "m2", "m3", "m4"]), ["none", "none", "none", "none"]);
    assert.equal(existsSync(blobPath(r, lonely)), false, "nothing else used it");
    assert.equal(existsSync(blobPath(r, onDraft)), true, "a draft still needs it");
    assert.equal(existsSync(blobPath(r, onImport)), true, "an imported message still needs it");
    assert.equal(existsSync(blobPath(r, onLogo)), true, "a sender logo still needs it");
    // The attachment rows stay, without a file: opening one loads the message again and downloads it.
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE remote_id IN ('m1','m2','m3','m4')) AND blob_sha256 IS NULL").n, 4);
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM attachments WHERE blob_sha256 IS NOT NULL").n, 1, "only the imported message's row keeps its file");
  });

  test("a failure while evicting is logged and never thrown", () => {
    const r = rig();
    put(r, { remoteId: "a" });
    limitMb(r, 0.0001);
    const warn = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...a: unknown[]) => void warned.push(a);
    try {
      r.env.ctx.db.run("DROP TABLE sender_logos");
      assert.equal(r.cache.enforce(), 0);
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1);
  });
});

describe("the one-time trim", () => {
  /** An install that downloaded everything: 120 inbox messages and 60 older ones, each with a file, some read lately. */
  function fatInstall() {
    const r = rig();
    const now = Date.now();
    for (let i = 0; i < 120; i++) put(r, { remoteId: `in${i}`, bytes: 20_000, inbox: true, sentAt: now - (200 - i) * 60_000, attachment: Buffer.from(`file ${i} `.repeat(200)) });
    for (let i = 0; i < 60; i++) put(r, { remoteId: `old${i}`, bytes: 20_000, sentAt: now - (30 + i) * DAY, viewedAt: i < 3 ? now - DAY : null, attachment: Buffer.from(`old file ${i} `.repeat(200)) });
    put(r, { remoteId: "sent:<mine@x>", bytes: 20_000, sentAt: now - 90 * DAY });
    return r;
  }

  test("returns everything outside the keep set to a summary, deletes files nothing refers to, and runs once", async () => {
    const r = fatInstall();
    const orphan = join(r.env.ctx.store.blobDir, "aa", "a".repeat(64));
    mkdirSync(join(r.env.ctx.store.blobDir, "aa"), { recursive: true });
    writeFileSync(orphan, "left behind by an old download");
    const before = r.cache.usage(LOCAL_USER_ID);

    const first = await r.cache.trimOnce({ batch: 25 });
    assert.equal(first.ran, true);
    assert.equal(first.trimmed, 70 + 57, "the 70 oldest inbox messages and the 57 old ones nobody read lately");
    const cached = r.env.ctx.db.all<{ remote_id: string }>("SELECT remote_id FROM messages WHERE body_state = 'cached'").map((m) => m.remote_id);
    assert.equal(cached.length, 50 + 3 + 1);
    assert.ok(Array.from({ length: 50 }, (_, i) => `in${i + 70}`).every((id) => cached.includes(id)), "the newest 50 inbox messages are whole");
    assert.ok(["old0", "old1", "old2", "sent:<mine@x>"].every((id) => cached.includes(id)), "what was read this week, and mail that can't be fetched again, stays");
    assert.equal(existsSync(orphan), false);
    assert.ok(r.cache.usage(LOCAL_USER_ID).total < before.total / 2);
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM maintenance WHERE task = 'trim-cache'").n, 1);

    // Done is done: a message that is whole again is not trimmed by a second start.
    r.env.ctx.db.run("UPDATE messages SET body_state = 'cached' WHERE remote_id = 'in0'");
    const second = await r.cache.trimOnce();
    assert.deepEqual(second, { ran: false, trimmed: 0, files: 0 });
    assert.equal(state(r, "in0"), "cached");
  });

  test("the usual limit waits while the trim works in small steps, then applies", async () => {
    const r = fatInstall();
    limitMb(r, 0.0001);
    const trim = r.cache.trimOnce({ batch: 10 });
    await new Promise((resolve) => setImmediate(resolve));
    const cachedMidway = row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages WHERE body_state = 'cached'").n;
    assert.ok(cachedMidway > 54, "the trim is still only a few batches in");
    assert.equal(r.cache.enforce(), 0, "a sync round that ends now doesn't evict hundreds of messages in one go");
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages WHERE body_state = 'cached'").n, cachedMidway);
    await trim;
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages WHERE body_state = 'cached'").n, 51, "afterwards the limit applies: the three read lately go too, leaving the newest 50 and the mail sent from here");
  });

  test("an interrupted trim leaves no marker, so the next start finishes it", async () => {
    const r = fatInstall();
    const stop = new AbortController();
    stop.abort();
    assert.equal((await r.cache.trimOnce({ signal: stop.signal })).ran, false);
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM maintenance").n, 0);
    assert.equal((await r.cache.trimOnce()).ran, true);
  });

  test("the file gives its space back to the disk through a VACUUM in a worker, while the server's own connection stays open", async () => {
    const r = fatInstall();
    await r.cache.trimOnce();
    r.env.ctx.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const free = r.cache.reclaimableBytes();
    assert.ok(free > 2_000_000, `the trim freed pages in the file: ${free}`);
    const before = statSync(r.env.ctx.config.dbPath).size;
    await vacuumInBackground(r.env.ctx.config.dbPath);
    assert.equal(r.cache.reclaimableBytes(), 0);
    assert.ok(statSync(r.env.ctx.config.dbPath).size < before - 2_000_000, "the file is smaller");
    assert.equal(row<{ n: number }>(r.env, "SELECT count(*) AS n FROM messages").n, 181, "and nothing was lost");
    assert.equal((row<{ quick_check: string }>(r.env, "PRAGMA quick_check")).quick_check, "ok");
  });
});

describe("doctor", () => {
  const offline = { health: async () => "none" as const, portFree: async () => true, env: {} };

  test("reports the cache against its limit, and warns when it is over", async () => {
    const r = rig();
    put(r, { remoteId: "a", bytes: 600_000 });
    put(r, { remoteId: "b", bytes: 600_000 });
    const ok = (await runDoctor(r.env.ctx.config, offline)).checks.find((c) => c.id === "cache")!;
    assert.equal(ok.status, "ok");
    assert.equal(ok.title, "Mail cache 1 MB of 100 MB");
    assert.match(ok.detail!, /2 messages are kept in full/);

    limitMb(r, 1);
    const over = (await runDoctor(r.env.ctx.config, offline)).checks.find((c) => c.id === "cache")!;
    assert.equal(over.status, "warn");
    assert.match(over.title, /over its 1 MB limit/);
    assert.match(over.fix!, /oldest read mail/);
  });

  test("says so when the cache is empty, and says nothing for a database with no accounts", async () => {
    const r = rig();
    assert.equal((await runDoctor(r.env.ctx.config, offline)).checks.find((c) => c.id === "cache")!.title, "Mail cache is empty (limit 100 MB)");
    r.env.ctx.db.run("DELETE FROM accounts");
    assert.equal((await runDoctor(r.env.ctx.config, offline)).checks.find((c) => c.id === "cache"), undefined);
  });
});
