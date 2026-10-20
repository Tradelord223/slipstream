// Renders the brand PNGs in docs/brand, and the web app icons in web/public, from their HTML sources in docs/brand/src.
// Usage: node scripts/render-brand.mjs        (after docs/screenshots changes, to refresh the social preview)
// Headless only. Uses the same browser lookup as capture-screenshots.mjs and never installs anything.
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const brand = join(root, "docs/brand");
const appIcons = join(root, "web/public");

const targets = [
  { src: "social-preview.html", out: "social-preview.png", width: 1280, height: 640, scale: 1 },
  { src: "banner-dark.html", out: "banner-dark.png", width: 1600, height: 400, scale: 2 },
  { src: "banner-light.html", out: "banner-light.png", width: 1600, height: 400, scale: 2 },
  // App icons live beside the web app so Vite serves them from the root. The "any" icon keeps its transparent corners.
  { src: "app-icon.html", out: "icon-192.png", dir: appIcons, width: 192, height: 192, scale: 1, transparent: true },
  { src: "app-icon.html", out: "icon-512.png", dir: appIcons, width: 512, height: 512, scale: 1, transparent: true },
  { src: "app-icon-maskable.html", out: "icon-maskable-512.png", dir: appIcons, width: 512, height: 512, scale: 1 },
  { src: "apple-touch-icon.html", out: "apple-touch-icon.png", dir: appIcons, width: 180, height: 180, scale: 1 },
];

const bin = chromePath();
if (!bin) {
  console.error("No headless Chrome found. Set CHROME_PATH to a Chrome or headless shell binary.");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, executablePath: bin });
try {
  for (const t of targets) {
    const ctx = await browser.newContext({ viewport: { width: t.width, height: t.height }, deviceScaleFactor: t.scale });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(join(brand, "src", t.src)).href);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((i) => i.decode()));
    });
    const out = join(t.dir ?? brand, t.out);
    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: t.width, height: t.height }, omitBackground: t.transparent });
    await ctx.close();
    console.log(`${t.out}  ${t.width * t.scale}x${t.height * t.scale}  ${Math.round(statSync(out).size / 1024)} KB`);
  }
} finally {
  await browser.close();
}
