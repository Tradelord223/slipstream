// Finds a headless Chromium for the scripts that drive a real browser (screenshots, the email render test).
// Order: CHROME_PATH, then the headless shell Playwright caches, then a system Chrome or Chromium.
// Nothing here installs a browser.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().at(-1);
    if (!dir) continue;
    const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-headless-shell"));
    const bin = sub && join(cache, dir, sub, "chrome-headless-shell");
    if (bin && existsSync(bin)) return bin;
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => existsSync(p));
}
