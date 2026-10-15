// Bundles the TypeScript server into one ESM file. Dependencies stay external (installed from npm).
import { build } from "esbuild";

await build({
  entryPoints: ["server/src/main.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
