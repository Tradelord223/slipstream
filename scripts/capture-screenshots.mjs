// Regenerates docs/screenshots from the built app and the demo inbox.
// Usage: npm run build && node scripts/capture-screenshots.mjs [outDir]
// It starts its own server on a temporary data directory, so nothing of yours is touched.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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

const dataDir = mkdtempSync(join(tmpdir(), "slipstream-shots-"));
const server = spawn(process.execPath, ["server/src/main.ts"], {
  cwd: root,
  env: { ...process.env, SLIPSTREAM_DATA_DIR: dataDir, SLIPSTREAM_PORT: String(port), SLIPSTREAM_SYNC_SECONDS: "600" },
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

try {
  await waitForServer();
  mkdirSync(out, { recursive: true });
  await call("POST", "/api/snippets", { name: "Intro call", subject: "Quick intro", bodyHtml: "<p>Hi {first_name}, would a 20 minute call this week work for you?</p>", shared: false });
  await call("POST", "/api/snippets", { name: "Thanks", bodyHtml: "<p>Thanks {first_name}, much appreciated.</p>", shared: false });
  await call("POST", "/api/snippets", { name: "Pricing", bodyHtml: "<p>Our plans start at {price} a month.</p>", shared: false });

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
  await browser.close();
  console.log(`Screenshots written to ${out}`);
} finally {
  server.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
}
