// Proves how Slipstream shows hostile mail. Usage: npm run test:render   (add --update to rewrite expected.json)
//
// Each fixture in web/test-fixtures/hostile-emails is shown through the app's real EmailBody (prepareBody,
// frameDocument and the sandboxed frame) in headless Chromium, once with images held back and once after
// "Show images". Every network request the page and its frames make is recorded, and the remote server
// counts what actually reaches it. The page being tested is on one local origin; every remote address
// (images.fernpoint.co and friends) is mapped to a second local server, and nothing else can resolve, so
// the run is offline.
//
// It needs a headless Chromium: set CHROME_PATH, or have Playwright's headless shell or a system Chrome installed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = join(root, "web/test-fixtures/hostile-emails");
const expectedPath = join(fixtureDir, "expected.json");
const update = process.argv.includes("--update");
// RENDER_ONLY=<part of a fixture name> runs just those fixtures while you work on one.
const only = process.env.RENDER_ONLY ?? "";
if (update && only) throw new Error("--update rewrites expected.json for every fixture, so it can't be combined with RENDER_ONLY");

const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const CSP_BLOCKED = "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; font-src data:";
const CSP_ALLOWED = "default-src 'none'; img-src data: 'self' https:; style-src 'unsafe-inline'; font-src data:";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const exe = chromePath();
if (!exe || !existsSync(exe)) {
  console.error(
    [
      "test:render needs a headless Chromium and couldn't find one.",
      "  - Point CHROME_PATH at a Chrome or Chromium binary, e.g. CHROME_PATH=/usr/bin/google-chrome npm run test:render",
      "  - or install Playwright's headless shell once: npx playwright-core install chromium-headless-shell",
      "This test fails instead of skipping, so a missing browser is never mistaken for a pass.",
    ].join("\n"),
  );
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "slipstream-render-"));
const cleanups = [() => rmSync(tmp, { recursive: true, force: true })];
const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const check = (ok, where, what) => {
  if (!ok) fail(where, what);
};

// --- The page under test, bundled from the real sources ---------------------------------------------------
const bundle = await build({
  entryPoints: [join(root, "web/test-fixtures/harness.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
});
const harnessJs = bundle.outputFiles[0].text;
const harnessPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><link rel="icon" href="data:,"><title>harness</title></head><body><div id="root"></div><script src="/harness.js"></script></body></html>`;

// --- Servers -----------------------------------------------------------------------------------------------
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const appRequests = [];
const app = http.createServer((req, res) => {
  const path = req.url ?? "/";
  if (path === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(harnessPage);
  if (path === "/harness.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(harnessJs);
  appRequests.push(path);
  // Stands in for /api/attachments/:id?inline=1, which serves an inline image the sender attached.
  res.writeHead(200, { "content-type": path.startsWith("/api/attachments/att_logo") ? "image/gif" : "text/plain" }).end(path.startsWith("/api/attachments/att_logo") ? GIF : "no");
});
const appPort = await listen(app);
cleanups.push(() => app.close());
const appOrigin = `http://127.0.0.1:${appPort}`;

try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"), "-days", "1", "-subj", "/CN=fernpoint.test"], { stdio: "ignore" });
} catch {
  console.error("test:render needs the `openssl` command to make a throwaway certificate for the local test server.");
  process.exit(1);
}
const tls = { key: readFileSync(join(tmp, "key.pem")), cert: readFileSync(join(tmp, "cert.pem")) };

// The "internet": one server on one port that answers both http and https, and counts everything that reaches it.
const remote = { connections: 0, requests: [] };
const answer = (scheme) => (req, res) => {
  remote.requests.push({ scheme, host: req.headers.host, url: req.url, referer: req.headers.referer ?? null });
  res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" }).end(GIF);
};
const plainServer = http.createServer(answer("http"));
const tlsServer = https.createServer(tls, answer("https"));
for (const s of [plainServer, tlsServer]) {
  s.on("clientError", (_e, socket) => socket.destroy());
  s.on("tlsClientError", () => {});
}
const front = net.createServer((socket) => {
  remote.connections++;
  socket.on("error", () => {});
  socket.once("data", (chunk) => {
    socket.pause();
    socket.unshift(chunk);
    (chunk[0] === 0x16 ? tlsServer : plainServer).emit("connection", socket);
    process.nextTick(() => socket.resume());
  });
});
const remotePort = await listen(front);
cleanups.push(() => front.close());
const resetCounts = () => {
  appRequests.length = 0;
  remote.connections = 0;
  remote.requests.length = 0;
};

// --- Browser -----------------------------------------------------------------------------------------------
const browser = await chromium.launch({
  headless: true,
  executablePath: exe,
  args: [`--host-resolver-rules=MAP *.fernpoint.co 127.0.0.1:${remotePort}, MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`, "--no-proxy-server"],
});
cleanups.push(() => browser.close());

const norm = (url) => url.replaceAll(`127.0.0.1:${remotePort}`, "127.0.0.1:__REMOTE_PORT__");

const messageFor = (id, html) => ({
  id,
  from: { name: "Fernpoint", email: "news@fernpoint.co" },
  to: [{ name: "", email: "reader@fernpoint.co" }],
  cc: [],
  bcc: [],
  replyTo: null,
  subject: id,
  sentAt: Date.UTC(2026, 9, 1),
  snippet: "",
  text: "",
  html,
  unread: false,
  outgoing: false,
  canUnsubscribe: false,
  attachments: [{ id: "att_logo", filename: "logo.png", mimeType: "image/png", size: GIF.length, contentId: "<logo@fernpoint.co>", inline: true }],
});

/** A fresh browser profile with everything that can leave the page recorded. */
async function startSession() {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 3000 } });
  const s = { ctx, requests: [], dialogs: [], popups: [], navigations: [] };
  // Chromium reports a request to the recorder before it checks the frame's CSP, so a request it then refuses
  // (Chromium reports it as failed with "csp") is marked and counted apart. The remote server's own count is the authority on what left.
  ctx.on("request", (r) => s.requests.push({ url: r.url(), type: r.resourceType(), csp: false, req: r }));
  ctx.on("requestfailed", (r) => {
    const entry = s.requests.find((x) => x.req === r);
    const reason = r.failure()?.errorText ?? "failed";
    if (entry) entry.failed = reason;
    if (entry && /(^csp$|BLOCKED_BY_CSP)/.test(reason)) entry.csp = true;
  });
  s.page = await ctx.newPage();
  s.page.on("dialog", (d) => {
    s.dialogs.push(`${d.type()}: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  ctx.on("page", (p) => s.popups.push(p));
  s.page.on("framenavigated", (f) => s.navigations.push(f.url()));
  return s;
}

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(350);
}

/** What a reader could do: scroll, open every quote, hover every link. Lazy and :hover loads happen here. */
async function exercise(page) {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      document.querySelectorAll("details").forEach((d) => (d.open = true));
      window.scrollTo(0, document.documentElement.scrollHeight);
    }).catch(() => {});
    for (const el of (await frame.locator("a, area, summary").all()).slice(0, 40)) await el.hover({ force: true, timeout: 300 }).catch(() => {});
  }
  await settle(page);
}

async function mount(s, message) {
  await s.page.goto(`${appOrigin}/`);
  await s.page.evaluate((m) => window.mountMail(m), message);
  await s.page.waitForSelector(".body-native, .paper iframe");
  await settle(s.page);
}

/** Runs in the page or a frame: lists anything in the rendered mail that could run code or load something. */
function inspectRendered({ selector, origin }) {
  const root = selector === "body" ? document.body : document.querySelector(selector);
  if (!root) return { problems: ["nothing rendered"], links: [] };
  const problems = [];
  const banned = "script, iframe, frame, frameset, object, embed, applet, form, input, button, textarea, select, link, meta, base, svg, math, video, audio, source, track, canvas, dialog, noscript, xmp, plaintext";
  for (const el of root.querySelectorAll(banned)) problems.push(`<${el.tagName.toLowerCase()}> survived`);
  for (const el of root.querySelectorAll("*")) {
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) problems.push(`${a.name} handler survived on <${el.tagName.toLowerCase()}>`);
      if (["srcdoc", "srcset", "formaction", "ping", "poster", "longdesc", "lowsrc", "dynsrc"].includes(a.name)) problems.push(`${a.name} survived on <${el.tagName.toLowerCase()}>`);
      if (/^\s*(javascript:|vbscript:|data:text)/i.test(a.value) || /expression\s*\(/i.test(a.value)) problems.push(`${a.name}="${a.value.slice(0, 40)}" survived on <${el.tagName.toLowerCase()}>`);
    }
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src");
      if (src && !/^(data:image\/|https:\/\/)/i.test(src) && !src.startsWith(`${origin}/api/attachments/`)) problems.push(`<img src="${src.slice(0, 50)}"> kept`);
    }
  }
  const links = [...root.querySelectorAll("[href]")].map((el) => ({ tag: el.tagName.toLowerCase(), href: el.getAttribute("href"), target: el.getAttribute("target"), rel: el.getAttribute("rel") }));
  return { problems, links };
}

async function inspectAll(s, kind, where) {
  const targets = [];
  if (kind === "simple") targets.push({ frame: s.page.mainFrame(), selector: ".body-native" });
  else for (const f of s.page.frames()) if (f !== s.page.mainFrame()) targets.push({ frame: f, selector: "body" });
  for (const { frame, selector } of targets) {
    const { problems, links } = await frame.evaluate(inspectRendered, { selector, origin: appOrigin });
    for (const p of problems) fail(where, p);
    for (const l of links) {
      const good = (l.tag === "a" || l.tag === "area") && (l.href === null || /^(https?:|mailto:|tel:)/i.test(l.href)) && l.target === "_blank" && /\bnoopener\b/.test(l.rel ?? "") && /\bnoreferrer\b/.test(l.rel ?? "");
      if (!good) fail(where, `unsafe link kept: <${l.tag} href="${l.href}" target="${l.target}" rel="${l.rel}">`);
    }
  }
}

/** The one thing every run checks, blocked or allowed. */
async function commonChecks(s, kind, where) {
  const sentinel = [];
  for (const f of s.page.frames()) sentinel.push(await f.evaluate(() => window.__pwned).catch(() => undefined));
  check(sentinel.every((v) => v === undefined), where, `script ran (sentinel ${JSON.stringify(sentinel)})`);
  check(s.dialogs.length === 0, where, `dialog opened: ${s.dialogs.join(", ")}`);
  check(s.popups.length === 0, where, "a popup or new tab opened");
  check(s.page.url() === `${appOrigin}/`, where, `the page navigated to ${s.page.url()}`);
  const frames = s.page.frames().filter((f) => f !== s.page.mainFrame());
  check(frames.length === (kind === "rich" ? 1 : 0), where, `expected ${kind === "rich" ? 1 : 0} frame(s), found ${frames.length}`);
  for (const f of frames) check(f.url() === "about:srcdoc", where, `a frame navigated to ${f.url()}`);
  check(remote.requests.every((r) => r.scheme === "https"), where, `a plain http request reached the remote server: ${remote.requests.filter((r) => r.scheme === "http").map((r) => r.url).join(", ")}`);
  const odd = s.requests.filter((r) => !/^(data|about|blob|cid):/i.test(r.url) && !/^https?:/i.test(r.url));
  check(odd.length === 0, where, `unexpected request schemes: ${odd.map((r) => r.url).join(", ")}`);
  await inspectAll(s, kind, where);
}

const external = (s) => s.requests.filter((r) => /^https?:/i.test(r.url) && !r.url.startsWith(`${appOrigin}/`) && !r.csp);
const refusedByCsp = (s) => s.requests.filter((r) => r.csp).length;
const sameOrigin = (s) => [...new Set(s.requests.filter((r) => r.url.startsWith(`${appOrigin}/`)).map((r) => r.url.slice(appOrigin.length)))].filter((p) => p !== "/" && p !== "/harness.js").sort();

// --- Fixtures ---------------------------------------------------------------------------------------------
const MUST_LOAD_ALL = new Set(["17-designed-newsletter"]);
const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : {};
const observed = {};
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".html") && f.includes(only)).sort();
check(fixtures.length > 0, "fixtures", "no fixtures found");
const rows = [];

for (const file of fixtures) {
  const name = file.replace(/\.html$/, "");
  const html = readFileSync(join(fixtureDir, file), "utf8").replaceAll("__REMOTE_PORT__", String(remotePort));
  const message = messageFor(name, html);

  // 1. Images held back (the default).
  resetCounts();
  let s = await startSession();
  let where = `${name} [images blocked]`;
  await mount(s, message);
  const kind = (await s.page.locator(".paper iframe").count()) ? "rich" : "simple";
  const banner = (await s.page.locator(".image-banner").count()) > 0;
  await exercise(s.page);
  await commonChecks(s, kind, where);
  check(external(s).length === 0, where, `requests left for other origins: ${external(s).map((r) => `${r.type} ${r.url}`).join(", ")}`);
  check(remote.connections === 0, where, `${remote.connections} connection(s) reached the remote server`);
  check(remote.requests.length === 0, where, "requests reached the remote server");
  if (kind === "rich") {
    const iframe = s.page.locator(".paper iframe");
    check((await iframe.getAttribute("sandbox")) === SANDBOX, where, "sandbox attribute changed");
    check((await iframe.getAttribute("referrerpolicy")) === "no-referrer", where, "frame referrer policy changed");
    const doc = (await iframe.getAttribute("srcdoc")) ?? "";
    check(doc.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP_BLOCKED}">`), where, "frame CSP is not the blocked-images policy");
  }
  const blockedSame = sameOrigin(s);
  const blockedCsp = refusedByCsp(s);
  if (process.env.RENDER_VERBOSE) for (const r of s.requests.filter((x) => x.csp)) console.log(`  ${name}: the frame's policy refused ${r.type} ${r.url}`);
  await s.ctx.close();

  // 2. After "Show images", when the message offered it.
  resetCounts();
  s = await startSession();
  where = `${name} [images shown]`;
  await mount(s, message);
  if (banner) {
    await s.page.getByRole("button", { name: "Show images", exact: true }).click();
    await s.page.waitForSelector(".image-banner", { state: "detached" });
    await settle(s.page);
  }
  await exercise(s.page);
  await commonChecks(s, kind, where);
  // The remote server's count is what actually left. Everything the browser reported beyond that was refused before sending.
  const shown = external(s);
  const reached = [...new Set(remote.requests.map((r) => norm(`https://${r.host}${r.url}`)))].sort();
  for (const r of shown) {
    const url = norm(r.url);
    if (!reached.includes(url)) {
      check(Boolean(r.failed), where, `${r.type} ${r.url} was reported but neither failed nor reached the server`);
      continue;
    }
    const typeOk = r.type === "image" || (r.type === "other" && /\.svg$/.test(new URL(r.url).pathname));
    check(typeOk && r.url.startsWith("https://") && /^https:\/\/(images\.fernpoint\.co|pixel\.fernpoint\.co|127\.0\.0\.1:\d+)\//.test(r.url), where, `a request that is not an https image left: ${r.type} ${r.url}`);
  }
  for (const url of reached) check(shown.some((r) => norm(r.url) === url), where, `the remote server saw ${url}, which the browser never reported`);
  const shownUrls = reached;
  if (kind === "rich") {
    const doc = (await s.page.locator(".paper iframe").getAttribute("srcdoc")) ?? "";
    check(doc.includes(`content="${banner ? CSP_ALLOWED : CSP_BLOCKED}"`), where, "frame CSP is not the expected policy");
  }
  const shownSame = sameOrigin(s);
  const shownCsp = refusedByCsp(s);
  await s.ctx.close();

  observed[name] = { kind, banner, allowedRequests: shownUrls, sameOrigin: [...new Set([...blockedSame, ...shownSame])].sort() };
  rows.push({ name, kind, banner, blockedCsp, shown: shownUrls.length, shownCsp });
}

// --- Reply and forward quote the message into the editor, which has no frame around it ---------------------------
for (const file of fixtures) {
  const name = file.replace(/\.html$/, "");
  const message = messageFor(name, readFileSync(join(fixtureDir, file), "utf8").replaceAll("__REMOTE_PORT__", String(remotePort)));
  resetCounts();
  const s = await startSession();
  const where = `${name} [reply and forward]`;
  await s.page.goto(`${appOrigin}/`);
  for (const kind of ["reply", "forward"]) {
    await s.page.evaluate(([m, k]) => window.mountComposer(m, k), [message, kind]);
    await s.page.waitForSelector("#composer [contenteditable]");
    await settle(s.page);
    const { problems, links } = await s.page.evaluate(inspectRendered, { selector: "#composer [contenteditable]", origin: appOrigin });
    for (const p of problems) fail(where, `${kind}: ${p}`);
    for (const l of links) check((l.tag === "a" || l.tag === "area") && (l.href === null || /^(https?:|mailto:|tel:)/i.test(l.href)), where, `${kind}: unsafe link kept in the quote: <${l.tag} href="${l.href}">`);
  }
  check(external(s).length === 0, where, `requests left when quoting: ${external(s).map((r) => `${r.type} ${r.url}`).join(", ")}`);
  check(remote.connections === 0 && remote.requests.length === 0, where, "the remote server was contacted when quoting");
  check((await s.page.evaluate(() => window.__pwned)) === undefined, where, "script ran when quoting");
  check(s.dialogs.length === 0, where, "dialog opened when quoting");
  check(s.popups.length === 0 && s.page.url() === `${appOrigin}/`, where, "the page navigated or opened a tab when quoting");
  await s.ctx.close();
}

// --- Controls: the instruments must be able to see a leak -------------------------------------------------
{
  resetCounts();
  const s = await startSession();
  const where = "control (unsanitized HTML)";
  await s.page.goto(`${appOrigin}/`);
  await s.page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", `<img src="https://pixel.fernpoint.co/control/raw.gif" onload="window.__pwned='raw'; alert('raw')"><iframe srcdoc="<img src='https://pixel.fernpoint.co/control/frame.gif'>"></iframe>`);
  });
  await settle(s.page);
  const urls = external(s).map((r) => r.url);
  check(urls.includes("https://pixel.fernpoint.co/control/raw.gif"), where, "the recorder missed a request from the page");
  check(urls.includes("https://pixel.fernpoint.co/control/frame.gif"), where, "the recorder missed a request from a frame");
  check(remote.requests.some((r) => r.url === "/control/raw.gif"), where, "the remote server didn't count the request");
  check(s.dialogs.length === 1, where, "the dialog listener missed an alert");
  check((await s.page.evaluate(() => window.__pwned)) === "raw", where, "the sentinel didn't flip");
  await s.ctx.close();
}

// --- "Always for this sender" is remembered in this browser only ----------------------------------------------
{
  const message = messageFor("always", readFileSync(join(fixtureDir, "17-designed-newsletter.html"), "utf8"));
  resetCounts();
  let s = await startSession();
  let where = "always for this sender";
  await mount(s, message);
  check((await s.page.locator(".image-banner").count()) === 1, where, "no banner on first view");
  check(external(s).length === 0, where, "requests left before the choice");
  appRequests.length = 0;
  await s.page.getByRole("button", { name: "Always for this sender", exact: true }).click();
  await settle(s.page);
  check(external(s).length > 0, where, "images did not load after the choice");
  check(appRequests.length === 0, where, `the choice contacted the app server: ${appRequests.join(", ")}`);
  const stored = await s.page.evaluate(() => localStorage.getItem("ss-image-senders"));
  check(stored === JSON.stringify(["news@fernpoint.co"]), where, `localStorage holds ${stored}`);
  // Same browser profile, later visit: remembered. Another profile: not.
  resetCounts();
  s.requests.length = 0;
  await mount(s, message);
  check((await s.page.locator(".image-banner").count()) === 0, where, "banner shown again for a remembered sender");
  check(external(s).length > 0, where, "remembered sender's images did not load");
  await s.ctx.close();
  resetCounts();
  s = await startSession();
  where = "show images (this time only)";
  await mount(s, message);
  await s.page.getByRole("button", { name: "Show images", exact: true }).click();
  await settle(s.page);
  check(external(s).length > 0, where, "images did not load");
  check((await s.page.evaluate(() => localStorage.getItem("ss-image-senders"))) === null, where, "'Show images' was remembered");
  s.requests.length = 0;
  await mount(s, message);
  check((await s.page.locator(".image-banner").count()) === 1 && external(s).length === 0, where, "'Show images' carried over to the next view");
  await s.ctx.close();
  resetCounts();
  s = await startSession();
  where = "fresh profile";
  await mount(s, message);
  check((await s.page.locator(".image-banner").count()) === 1 && external(s).length === 0, where, "a new browser profile inherited the choice");
  await s.ctx.close();
}

// --- Links open in a new tab, without opener or referrer --------------------------------------------------
for (const [fixture, href, imageMap] of [
  ["15-link-attributes", "https://evil.fernpoint.co/k/1", false],
  ["03-tracking-pixels", "https://evil.fernpoint.co/t/click", false],
  ["18-image-map-links", "https://evil.fernpoint.co/q/area-https", true],
]) {
  resetCounts();
  const s = await startSession();
  const where = `link click (${fixture})`;
  await mount(s, messageFor(fixture, readFileSync(join(fixtureDir, `${fixture}.html`), "utf8").replaceAll("__REMOTE_PORT__", String(remotePort))));
  const frame = (await s.page.locator(".paper iframe").count()) ? s.page.frames().find((f) => f !== s.page.mainFrame()) : s.page.mainFrame();
  if (imageMap) {
    await s.page.getByRole("button", { name: "Show images", exact: true }).click();
    await settle(s.page);
  }
  const popup = s.ctx.waitForEvent("page", { timeout: 5000 });
  if (imageMap) await frame.locator("img").click({ position: { x: 20, y: 20 } });
  else await frame.locator(`a[href="${href}"]`).first().click();
  const tab = await popup.catch(() => null);
  check(tab !== null, where, "the link did not open a new tab");
  if (tab) {
    await tab.waitForLoadState("load").catch(() => {});
    check((await tab.evaluate(() => window.opener).catch(() => "error")) === null, where, "the new tab can reach the mail page (window.opener)");
    check(tab.url() === href, where, `new tab went to ${tab.url()}`);
    const hit = remote.requests.find((r) => r.url === new URL(href).pathname);
    check(Boolean(hit), where, "the new tab's request never reached the remote server");
    check(hit?.referer === null, where, `the new tab sent a Referer: ${hit?.referer}`);
  }
  check(s.page.url() === `${appOrigin}/`, where, "the mail page itself navigated");
  await s.ctx.close();
}

// --- Verdict ------------------------------------------------------------------------------------------------
if (update) {
  writeFileSync(expectedPath, `${JSON.stringify(observed, null, 2)}\n`);
  console.log(`Wrote ${expectedPath}`);
} else {
  for (const name of Object.keys(observed)) {
    const want = expected[name];
    if (!want) fail(name, "no entry in expected.json (run with --update after reviewing the output)");
    else {
      const got = observed[name];
      for (const key of ["kind", "banner", "sameOrigin"]) {
        if (JSON.stringify(want[key]) !== JSON.stringify(got[key])) fail(name, `${key} is ${JSON.stringify(got[key])}, expected.json says ${JSON.stringify(want[key])}`);
      }
      // Which CSS-referenced pictures Chromium fetches varies a little between browser builds, so the reviewed list
      // is a ceiling: nothing outside it may load. A normal newsletter must still load all of its pictures.
      const extra = got.allowedRequests.filter((u) => !want.allowedRequests.includes(u));
      if (extra.length) fail(name, `loaded pictures that expected.json doesn't list: ${extra.join(", ")}`);
      if (MUST_LOAD_ALL.has(name)) {
        const missing = want.allowedRequests.filter((u) => !got.allowedRequests.includes(u));
        if (missing.length) fail(name, `a normal message lost pictures after Show images: ${missing.join(", ")}`);
      }
    }
  }
  if (!only) for (const name of Object.keys(expected)) if (!observed[name]) fail(name, "listed in expected.json but there is no such fixture");
}

for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});

const pad = (v, n) => String(v).padEnd(n);
console.log(`\n${pad("fixture", 34)}${pad("shown as", 10)}${pad("banner", 8)}${pad("held back: left the page", 26)}${pad("held back: refused by frame CSP", 34)}${pad("images shown: left the page", 29)}images shown: refused by CSP`);
for (const r of rows) console.log(`${pad(r.name, 34)}${pad(r.kind, 10)}${pad(r.banner ? "yes" : "no", 8)}${pad(0, 26)}${pad(r.blockedCsp, 34)}${pad(r.shown, 29)}${r.shownCsp}`);

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nAll ${rows.length} fixtures render safely, in the reading view and quoted in a reply or forward. Held back by default: nothing left the page. After "Show images": only https pictures.`);
process.exit(0);
