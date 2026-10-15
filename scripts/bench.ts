// Measures the operations you feel: opening a split, searching, triaging.
// Usage: node scripts/bench.ts [messageCount]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/src/config.ts";
import { createApp } from "../server/src/http/app.ts";
import { newId } from "../server/src/lib/crypto.ts";
import { createContext } from "../server/src/main.ts";
import type { AccountRow } from "../server/src/mail/store.ts";
import type { IncomingMessage } from "../server/src/mail/types.ts";

const COUNT = Number(process.argv[2] ?? 50_000);
const dir = mkdtempSync(join(tmpdir(), "slipstream-bench-"));
const port = 4398;
const config = loadConfig({
  dataDir: dir,
  dbPath: join(dir, "bench.db"),
  port,
  allowedHosts: new Set([`127.0.0.1:${port}`]),
  demo: false,
});
const ctx = createContext(config);
const user = ctx.users.ensureLocalUser();
const accountId = newId("acc");
ctx.db.run(
  "INSERT INTO accounts (id, user_id, provider, email, name, created_at) VALUES (?,?,?,?,?,?)",
  accountId,
  user.id,
  "demo",
  "me@bench.test",
  "Me",
  Date.now(),
);
const account = ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId)!;

// A Zipf-like vocabulary: a few very common words, a long tail of rare ones (like real mail).
const COMMON = "the team update meeting thanks please review project next week".split(" ");
const TOPICS = "launch budget contract invoice design roadmap hiring offsite quarterly metrics feedback prototype vendor shipping renewal onboarding incident retro proposal".split(" ");
const WORDS = [...COMMON, ...TOPICS, ...Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}`)];
const zipf = (r: number) => Math.floor(WORDS.length * r ** 3);
const PEOPLE = Array.from({ length: 400 }, (_, i) => ({ name: `Person ${i}`, email: `person${i}@company${i % 40}.test` }));
const pick = <T,>(a: T[], i: number) => a[i % a.length]!;

// Deterministic pseudo-random so runs are comparable.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

console.log(`Seeding ${COUNT.toLocaleString()} messages…`);
const t0 = performance.now();
const now = Date.now();
const batch: IncomingMessage[] = [];
for (let i = 0; i < COUNT; i++) {
  const thread = Math.floor(i / 3);
  const from = pick(PEOPLE, Math.floor(rand() * 4000));
  const w = (n: number) => Array.from({ length: n }, () => WORDS[zipf(rand())]!).join(" ");
  batch.push({
    remoteId: `b${i}`,
    remoteThreadId: `t${thread}`,
    messageIdHeader: `<b${i}@bench.test>`,
    from,
    to: [{ name: "Me", email: "me@bench.test" }],
    cc: [],
    bcc: [],
    subject: `${w(3)} ${thread}`,
    sentAt: now - (COUNT - i) * 60_000,
    bodyText: `${w(60)}\n\n${w(40)}`,
    unread: rand() < 0.2,
    starred: rand() < 0.03,
    folders: { inbox: i > COUNT - 3000, sent: false, trash: false, spam: false },
    bulk: rand() < 0.4,
    attachments: [],
  });
  if (batch.length === 1000) ctx.store.ingest(account, { messages: batch.splice(0), cursor: null, done: true });
}
if (batch.length) ctx.store.ingest(account, { messages: batch, cursor: null, done: true });
const seedMs = performance.now() - t0;
const threads = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM threads")!.n;
console.log(`Seeded in ${(seedMs / 1000).toFixed(1)} s (${Math.round(COUNT / (seedMs / 1000)).toLocaleString()} messages/s), ${threads.toLocaleString()} threads\n`);

const app = createApp(ctx);
const api = async (path: string, init: RequestInit = {}) => {
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { host: `127.0.0.1:${port}`, "x-slipstream": "1", "content-type": "application/json", ...(init.headers ?? {}) },
    }),
  );
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
};

async function measure(label: string, fn: () => Promise<unknown>, runs = 30) {
  await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!;
  console.log(`${label.padEnd(60)} p50 ${p(0.5).toFixed(2).padStart(7)} ms   p95 ${p(0.95).toFixed(2).padStart(7)} ms`);
  return { label, p50: p(0.5), p95: p(0.95) };
}

const hits = async (q: string) =>
  ((await api(`/api/threads?view=search&limit=500&q=${encodeURIComponent(q)}`)).threads as unknown[]).length + "+";
const boot = await api("/api/bootstrap");
const important = boot.splits[0].id as string;
const results = [
  await measure("Open Important split (first 100 rows)", () => api(`/api/threads?view=split&split=${important}`)),
  await measure("Open inbox (first 100 rows)", () => api("/api/threads?view=inbox")),
  await measure("Unread counts for every split", () => api("/api/counts")),
  await measure(`Full-text search, typical ("w5k contract": ${await hits("w5k contract")} threads)`, () => api("/api/threads?view=search&q=w5k%20contract")),
  await measure(`Full-text search, worst case ("the": ${await hits("the")} threads)`, () => api("/api/threads?view=search&q=the")),
  await measure("Search from:company7 has no attachment", () => api("/api/threads?view=search&q=from:company7%20-is:unread")),
];

const inbox = (await api("/api/threads?view=inbox&limit=500")).threads as { id: string }[];
let k = 0;
results.push(
  await measure(
    "Mark done (local write + queued sync)",
    async () => {
      const id = inbox[k++ % inbox.length]!.id;
      const r = await api("/api/triage", { method: "POST", body: JSON.stringify({ kind: "done", threadIds: [id] }) });
      await api("/api/undo", { method: "POST", body: JSON.stringify({ undoToken: r.undoToken }) });
    },
    100,
  ),
);
const firstThread = inbox[0]!.id;
results.push(await measure("Open a conversation", () => api(`/api/threads/${firstThread}`)));

ctx.db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n(Mark done row includes the undo round-trip, so it's two writes.)`);
if (process.env.BENCH_JSON) console.log(JSON.stringify({ count: COUNT, threads, seedMs, results }));
