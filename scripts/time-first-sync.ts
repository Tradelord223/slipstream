// Times the first sync of one of your connected accounts, read-only: how long until the newest 100 inbox summaries are in,
// and how many bytes came over the wire to get them.
//
// Usage: node scripts/time-first-sync.ts [gmail|outlook|imap|N] [--history] [--recent]
//   gmail|outlook|imap|N  which account (the first of that kind, or the Nth); default the first
//   --history             keep going through the rest of the 30-day window
//   --recent              also fetch the full text of the newest 50 inbox messages, like the recent cache does
//
// It reads the account from your Slipstream data folder (SLIPSTREAM_DATA_DIR, else ~/.slipstream) and runs the provider
// in memory. Nothing is written: the database is opened read-only, no message is stored, and a refreshed sign-in token
// is not saved. It prints counts and timings only, never subjects, addresses or credentials.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../server/src/config.ts";
import { SecretBox } from "../server/src/lib/crypto.ts";
import type { MailProvider, ProviderContext, ProviderKind, SyncPage } from "../server/src/mail/types.ts";
import { createProvider } from "../server/src/providers/index.ts";
import { createImapFlow, ImapProvider, type ImapSettings } from "../server/src/providers/imap.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const pick = args.find((a) => !a.startsWith("--"));

const dataDir = resolve(process.env.SLIPSTREAM_DATA_DIR ?? join(homedir(), ".slipstream"));
const dbPath = join(dataDir, "slipstream.db");
if (!existsSync(dbPath)) fail(`No Slipstream database at ${dataDir}. Set SLIPSTREAM_DATA_DIR if your data lives somewhere else.`);
// SecretBox would create a key file if there isn't one; a timing run must not write anything.
if (!process.env.SLIPSTREAM_SECRET && !existsSync(join(dataDir, "secret.key"))) fail("No secret.key in the data folder, so the saved sign-ins can't be read.");

// A WAL database opened even read-only would leave -wal and -shm files behind. While Slipstream is running they already
// exist and are read as they are; otherwise the file is opened immutable, which touches nothing.
const running = existsSync(`${dbPath}-wal`);
const db = new DatabaseSync(running ? dbPath : `file:${dbPath}?mode=ro&immutable=1`, { readOnly: true });
const accounts = db.prepare("SELECT id, provider, auth_enc FROM accounts WHERE provider IN ('gmail', 'outlook', 'imap') ORDER BY created_at").all() as {
  id: string;
  provider: ProviderKind;
  auth_enc: string | null;
}[];
if (accounts.length === 0) fail("No Gmail, Outlook or IMAP account is connected.");
const index = pick && /^\d+$/.test(pick) ? Number(pick) - 1 : accounts.findIndex((a) => !pick || a.provider === pick);
const account = accounts[index];
if (!account || !account.auth_enc) fail(`No such account. Connected: ${accounts.map((a, i) => `${i + 1} (${a.provider})`).join(", ")}.`);
const email = (db.prepare("SELECT email FROM accounts WHERE id = ?").get(account.id) as { email: string }).email;

const config = loadConfig({ dataDir });
const auth = new SecretBox(dataDir).open<unknown>(account.auth_enc);
const ctx: ProviderContext = { accountId: account.id, email, auth, saveAuth() {}, initialSyncDays: 30 };

// Bytes received: HTTP bodies for Gmail and Graph, the socket for IMAP.
let httpBytes = 0;
let requests = 0;
const reading: Promise<void>[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
  requests++;
  const res = await realFetch(...a);
  reading.push(res.clone().arrayBuffer().then((b) => void (httpBytes += b.byteLength), () => {}));
  return res;
}) as typeof fetch;
const imapClients: ReturnType<typeof createImapFlow>[] = [];
const provider: MailProvider =
  account.provider === "imap"
    ? new ImapProvider(ctx, {
        createClient: (s: ImapSettings) => {
          const c = createImapFlow(s);
          imapClients.push(c);
          return c;
        },
      })
    : createProvider(account.provider, ctx, config);

const received = async () => {
  await Promise.all(reading);
  return httpBytes + imapClients.reduce((n, c) => n + (c.stats().received ?? 0), 0);
};
const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

console.log(`Account ${index + 1} of ${accounts.length} (${account.provider}), reading the last 30 days`);
const start = performance.now();
process.on("uncaughtException", (err) => fail(`The sync stopped: ${scrub(err instanceof Error ? err.message : String(err))}`));
let inbox = 0;
const inboxMail: { id: string; at: number }[] = [];
let attachments = 0;
let all = 0;
let page: SyncPage | undefined;
let ready = false;
let cursor: string | null = null;
for (let i = 0; i < 2000; i++) {
  page = await provider.sync(cursor);
  cursor = page.cursor;
  all += page.messages.length;
  attachments += page.messages.filter((m) => m.attachments.length > 0).length;
  if (page.progress?.stage === "inbox") {
    inbox += page.messages.length;
    inboxMail.push(...page.messages.filter((m) => m.folders.inbox).map((m) => ({ id: m.remoteId, at: m.sentAt })));
  }
  if (!ready && page.progress?.stage === "inbox" && page.progress.last) {
    ready = true;
    console.log(`inbox ready: ${inbox} summaries in ${seconds(performance.now() - start)}, ${mb(await received())} received (${requests} HTTP requests)`);
    if (!flags.has("--history")) break;
  }
  if (page.done) break;
}
if (!ready) console.log(`no inbox stage reported; ${all} messages in ${seconds(performance.now() - start)}, ${mb(await received())} received`);
else if (flags.has("--history")) console.log(`window done: ${all} summaries (${attachments} with attachments) in ${seconds(performance.now() - start)}, ${mb(await received())} received in total`);

if (flags.has("--recent") && provider.fetchBody) {
  const before = await received();
  const t = performance.now();
  const ids = inboxMail.sort((a, b) => b.at - a.at).slice(0, 50).map((m) => m.id);
  let ok = 0;
  for (let i = 0; i < ids.length; i += 3) {
    ok += (await Promise.allSettled(ids.slice(i, i + 3).map((id) => provider.fetchBody!(id)))).filter((r) => r.status === "fulfilled").length;
  }
  console.log(`recent cache: ${ok} of ${ids.length} full messages in ${seconds(performance.now() - t)}, ${mb((await received()) - before)} received`);
}

await provider.close?.();
db.close();

/** Error text can carry an address; this prints counts and timings only. */
function scrub(text: string): string {
  return text.replace(/[^\s<>"']+@[^\s<>"']+/g, "<address>");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
