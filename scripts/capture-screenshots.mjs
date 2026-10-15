// Regenerates docs/screenshots from the built app and the demo inbox.
// Usage: npm run build && node scripts/capture-screenshots.mjs [outDir]
// It starts its own server on a temporary data directory, so nothing of yours is touched.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { FakeManagedAgents } from "./fake-managed-agents.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] ?? join(root, "docs/screenshots");
const port = 4396;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(root, "dist/web/index.html"))) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort();
  const dir = shells.at(-1);
  if (!dir) return undefined;
  const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-headless-shell"));
  const bin = sub && join(cache, dir, sub, "chrome-headless-shell");
  return bin && existsSync(bin) ? bin : undefined;
}

// A stand-in for Anthropic's Managed Agents, so the cloud agent has something to talk to (any API key works).
const fake = new FakeManagedAgents();
const fakeUrl = await fake.listen(4398);

const dataDir = mkdtempSync(join(tmpdir(), "slipstream-shots-"));
const server = spawn(process.execPath, ["server/src/main.ts"], {
  cwd: root,
  env: { ...process.env, SLIPSTREAM_DATA_DIR: dataDir, SLIPSTREAM_PORT: String(port), SLIPSTREAM_SYNC_SECONDS: "600", SLIPSTREAM_ANTHROPIC_BASE_URL: fakeUrl },
  stdio: "ignore",
});


async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`, { headers: { "x-slipstream": "1" } });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("The server didn't start");
}

const call = (method, path, body) =>
  fetch(base + path, { method, headers: { "x-slipstream": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

/** An agent acting through its own token, the way an assistant would. */
const asAgent = (token) => (command, input) =>
  fetch(`${base}/api/v1/${command}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input ?? {}) }).then((r) => r.json());

/** Colours, nested labels and a few rules, so the rail, chips and Settings → Labels have something to show. */
async function seedLabels() {
  const threads = (await call("GET", "/api/threads?view=inbox&limit=50")).threads;
  const bySubject = (text) => threads.find((t) => t.subject.includes(text));
  const cmd = (name, input) => call("POST", `/api/v1/${name}`, input ?? {});
  for (const [name, color] of [["Clients", "#3e8bff"], ["Research", "#12a594"], ["Team", "#ab4aba"], ["Travel", "#f76b15"]]) await cmd("labels.update", { name, color });
  await cmd("labels.create", { name: "Clients/Kettleby", color: "#30a46c" });
  await cmd("labels.create", { name: "Clients/Lumenridge", color: "#d6409f" });
  const kettleby = [bySubject("Dispatch dashboard"), bySubject("Invitation")].filter(Boolean).map((t) => t.id);
  if (kettleby.length) await call("POST", "/api/triage", { kind: "addLabel", threadIds: kettleby, label: "Clients/Kettleby" });
  await cmd("labelRules.create", { label: "Clients/Kettleby", query: "from:@kettlebyfreight.com", applyToExisting: true });
  await cmd("labelRules.create", { label: "Travel", query: "subject:flight", applyToExisting: false });
  await cmd("labelRules.create", { label: "Research", query: "has:attachment from:@lumenridge.com", applyToExisting: false });
}

/** Link the cloud agent and give it a history: three finished chats, one that asked to send a reply, and one still going. */
async function seedCloud() {
  const done = async (id) => {
    for (let i = 0; i < 80; i++) {
      const r = await call("GET", `/api/cloud/runs/${id}`);
      if (!["starting", "running"].includes(r.status) && r.costCents !== null) return r;
      await sleep(250);
    }
    throw new Error(`Run ${id} didn't finish`);
  };
  const connected = await call("POST", "/api/cloud/connect", { apiKey: "sk-ant-demo", scopes: ["read", "triage", "draft", "send"], policy: { send: "always" }, runBudgetCents: 100, monthlyBudgetCents: 2000 });
  if (!connected.connected) throw new Error(`Couldn't connect the cloud agent: ${connected.error}`);
  const runs = {};
  for (const [key, instruction] of [
    ["news", "Mark newsletters from before last week done"],
    ["invoices", "Remind me about the unpaid invoices on Friday"],
    ["walk", "Label this month's Kettleby mail as Clients/Kettleby"],
    ["priya", "Reply to Priya's dispatch dashboard feedback and send it"],
  ]) {
    const started = await call("POST", "/api/cloud/runs", { instruction });
    runs[key] = (await done(started.id)).id;
  }
  const held = await call("POST", "/api/cloud/runs", { instruction: "Draft replies to everyone waiting on me" });
  runs.held = held.id;
  await sleep(3000);
  const zone = "America/New_York";
  await call("POST", "/api/cloud/routines", { name: "Morning sweep", instruction: "Triage the inbox: mark newsletters and notifications done, remind me about anything I need to act on later this week, and draft replies to people waiting on me.", trigger: { type: "schedule", days: [1, 2, 3, 4, 5], time: "08:00", timezone: zone }, enabled: true });
  await call("POST", "/api/cloud/routines", { name: "Client replies", instruction: "Draft a reply to each new client message. Keep it short and plain.", trigger: { type: "mail", query: "from:@kettlebyfreight.com" }, enabled: true });
  await call("POST", "/api/cloud/routines", { name: "Friday clean-up", instruction: "Get the inbox to zero: mark done anything older than a week that doesn't need me, then list what's left.", trigger: { type: "schedule", days: [5], time: "16:00", timezone: zone }, enabled: false });
  return runs;
}

/** Two assistants with a few things done and three requests waiting in Review. Runs after the inbox shots, since it moves mail. */
async function seedAgents() {
  const threads = (await call("GET", "/api/threads?view=inbox&limit=50")).threads;
  const bySubject = (text) => threads.find((t) => t.subject.includes(text));
  const sweep = await call("POST", "/api/agents", { name: "Morning sweep", scopes: ["read", "triage", "settings"], policy: { bulkThreshold: 10, settings: "approve" } });
  const drafter = await call("POST", "/api/agents", { name: "Reply drafter", scopes: ["read", "draft", "send"], policy: { send: "always" } });
  const sweeper = asAgent(sweep.token);
  const writer = asAgent(drafter.token);

  const shipped = bySubject("Your order has shipped");
  const mugs = bySubject("Studio mugs");
  const invoice = bySubject("invoice for October");
  const tools = bySubject("Tools that get out");
  if (shipped) await sweeper("triage.done", { threadIds: [shipped.id] });
  if (invoice) await sweeper("triage.label", { threadIds: [invoice.id], label: "Receipts" });
  if (tools) await sweeper("triage.markRead", { threadIds: [tools.id] });
  const starred = tools && (await sweeper("triage.star", { threadIds: [tools.id] }));
  if (starred?.activityId) await call("POST", `/api/v1/activity/${starred.activityId}/undo`);

  if (mugs) {
    const draft = await writer("drafts.create", {
      threadId: mugs.id,
      body: "Hi Marco,\n\nTwelve mugs in the oat glaze works for us. Could you send the glaze card and a delivery estimate for the first week of November?\n\nThanks,\nJordan",
    });
    if (draft.result?.id) await writer("drafts.send", { draftId: draft.result.id });
  }
  const second = await writer("drafts.create", {
    to: [{ name: "Priya Raman", email: "priya@fernpoint.co" }],
    cc: ["sam@fernpoint.co"],
    subject: "Thursday walkthrough",
    body: "Hi Priya,\n\nThursday at 10 works. I'll bring the round 2 dashboard notes and we can go through the lane grouping together.\n\nSee you then,\nJordan",
  });
  if (second.result?.id) await writer("drafts.send", { draftId: second.result.id });
  await sweeper("triage.trash", { threadIds: threads.slice(0, 11).map((t) => t.id) });
  await sweeper("splits.create", { name: "Receipts", query: "label:receipts" });
}

try {
  await waitForServer();
  mkdirSync(out, { recursive: true });
  await call("POST", "/api/snippets", { name: "Intro call", subject: "Quick intro", bodyHtml: "<p>Hi {first_name}, would a 20 minute call this week work for you?</p>", shared: false });
  await call("POST", "/api/snippets", { name: "Thanks", bodyHtml: "<p>Thanks {first_name}, much appreciated.</p>", shared: false });
  await call("POST", "/api/snippets", { name: "Pricing", bodyHtml: "<p>Our plans start at {price} a month.</p>", shared: false });
  await seedLabels();

  const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
  const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
  const open = async (ctx, path = "/") => {
    const page = await ctx.newPage();
    await page.goto(base + path);
    await page.waitForSelector(".rail, .row", { timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(500);
    return page;
  };

  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
  let page = await open(dark);
  await page.waitForSelector(".row");
  await shot(page, "inbox-dark");

  for (let i = 0; i < 3; i++) await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".thread-subject");
  await sleep(700);
  await shot(page, "thread-dark");
  await page.keyboard.press("Escape");
  await sleep(300);

  await page.keyboard.press("h");
  await page.waitForSelector(".remind");
  await page.keyboard.type("tomorrow 9am");
  await sleep(450);
  await shot(page, "remind-dark");
  await page.keyboard.press("Escape");
  await sleep(250);

  await page.keyboard.press("Meta+k");
  await page.waitForSelector(".palette");
  await sleep(450);
  await shot(page, "palette-dark");
  await page.keyboard.press("Escape");
  await sleep(250);

  await page.keyboard.press("c");
  await page.waitForSelector(".composer-dock");
  await page.keyboard.type("pri");
  await page.waitForSelector(".suggest");
  await page.keyboard.press("Tab");
  await page.locator("#compose-subject").fill("Walkthrough on Thursday");
  await page.locator(".editor").click();
  await page.keyboard.type("Hi ;");
  await page.waitForSelector(".snippet-pop");
  await sleep(400);
  await shot(page, "compose-dark");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.keyboard.press("Meta+Shift+,");
  await sleep(300);

  await page.goto(base + "/settings/accounts");
  await page.waitForSelector(".account-row");
  await sleep(600);
  await shot(page, "settings-accounts-dark");

  await page.goto(base + "/");
  await page.waitForSelector(".row");
  const zero = await call("POST", "/api/zero", { olderThanDays: 0, keepStarred: false, keepUnread: false });
  await page.reload();
  await page.waitForSelector(".zero");
  await sleep(900);
  await shot(page, "zero-dark");
  if (zero.undoToken) await call("POST", "/api/undo", { undoToken: zero.undoToken });
  await dark.close();

  const light = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  page = await open(light);
  await page.waitForSelector(".row");
  await shot(page, "inbox-light");
  await light.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  page = await open(mobile);
  await page.waitForSelector(".row");
  await shot(page, "mobile-list");
  await page.locator(".row").nth(3).tap();
  await page.waitForSelector(".thread-subject");
  await sleep(700);
  await shot(page, "mobile-thread");
  await mobile.close();

  // Agents: Review, Activity, Settings -> Agents and Connect.
  await seedAgents();
  await call("POST", "/api/webhooks", { url: "https://hooks.fernpoint.example/slipstream", events: ["approval"] });
  const agentsDark = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark", timezoneId: "America/New_York" });
  page = await agentsDark.newPage();
  await page.route("**/api/remote", (r) =>
    r.fulfill({ json: { tailscale: { installed: true, running: true, dnsName: "studio.tail4f2a.ts.net", serve: { url: "https://studio.tail4f2a.ts.net" }, funnel: null }, publicListener: { port } } }),
  );
  const visit = async (path, ready) => {
    await page.goto(base + path);
    await page.waitForSelector(ready, { timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    await sleep(700);
  };
  // The assistant sidebar remembers whether it was open and which chat; set that before each page.
  const sidebar = (open, run = null) =>
    page.evaluate(
      ([o, r]) => {
        localStorage.setItem("ss-assistant", o ? "1" : "0");
        if (r) localStorage.setItem("ss-assistant-run", r);
        else localStorage.removeItem("ss-assistant-run");
      },
      [open, run],
    );
  await visit("/", ".row");
  await sidebar(true);
  await visit("/", ".cl-form");
  await shot(page, "agent-setup-dark");
  await sidebar(false);
  const runs = await seedCloud();
  await visit("/review", ".rv-card");
  await shot(page, "review-dark");
  await visit("/activity", ".act-row");
  await shot(page, "activity-dark");
  await visit("/settings/agents", ".ag-row");
  await shot(page, "agents-dark");
  await visit("/settings/connect", ".snip");
  await page.evaluate(() => document.querySelector(".settings-content")?.scrollTo(0, 99999));
  await sleep(300);
  await shot(page, "connect-dark");

  await visit("/label/Clients", ".row");
  await shot(page, "labels-dark");
  await visit("/settings/labels", ".lb-row");
  await page.evaluate(() => document.querySelector(".settings-content")?.scrollTo(0, 99999));
  await sleep(500);
  await shot(page, "label-rules-dark");

  await visit("/agent", ".cl-routine");
  await shot(page, "agent-dark");
  await page.click('button[aria-label="Edit Morning sweep"]');
  await page.waitForSelector(".dialog-agent");
  await sleep(400);
  await shot(page, "routine-dark");
  await page.keyboard.press("Escape");

  const priya = (await call("GET", "/api/threads?view=search&q=in:all&limit=100")).threads.find((t) => t.subject.includes("Dispatch dashboard"));
  await sidebar(true, runs.priya);
  await visit(`/t/${priya.id}`, ".tr-ask");
  await shot(page, "assistant-dark");
  await sidebar(false);
  await agentsDark.close();

  const mobileReview = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", timezoneId: "America/New_York" });
  page = await mobileReview.newPage();
  await page.goto(base + "/review");
  await page.waitForSelector(".rv-card");
  await page.evaluate(() => document.fonts.ready);
  await sleep(700);
  await shot(page, "mobile-review");
  await page.goto(base + "/agent");
  await page.waitForSelector(".cl-routine");
  await page.evaluate(() => document.fonts.ready);
  await sleep(700);
  await shot(page, "mobile-agent");
  await page.evaluate(([r]) => (localStorage.setItem("ss-assistant", "1"), localStorage.setItem("ss-assistant-run", r)), [runs.priya]);
  await page.goto(`${base}/t/${priya.id}`);
  await page.waitForSelector(".tr-ask");
  await page.evaluate(() => document.fonts.ready);
  await sleep(700);
  await shot(page, "mobile-assistant");
  await mobileReview.close();
  await browser.close();
  console.log(`Screenshots written to ${out}`);
} finally {
  server.kill("SIGTERM");
  fake.close();
  rmSync(dataDir, { recursive: true, force: true });
}
