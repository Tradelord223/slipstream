// Bundles the TypeScript server into one ESM file. Dependencies stay external (installed from npm).
import { build } from "esbuild";

await build({
  entryPoints: { server: "server/src/main.ts", mcp: "server/src/mcp.ts" },
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
