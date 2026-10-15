// Bundles the TypeScript server into one ESM file. Dependencies stay external (installed from npm).
import { build } from "esbuild";
import { existsSync, readdirSync, rmSync } from "node:fs";

// Start clean (the web app in dist/web is built separately), so nothing stale ships.
if (existsSync("dist")) for (const name of readdirSync("dist", { withFileTypes: true }).filter((e) => e.name !== "web").map((e) => e.name))
  rmSync(`dist/${name}`, { recursive: true, force: true });

await build({
  entryPoints: { server: "server/src/main.ts", cli: "server/src/cli.ts" },
  outdir: "dist",
  // Both entries share modules; splitting keeps one copy of each.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
