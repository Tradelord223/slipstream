#!/usr/bin/env node
// `npx slipstream-mail` — runs Slipstream locally at http://127.0.0.1:4380.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Slipstream needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
const sub = process.argv[2];
if (!sub || sub === "serve") {
  const { start } = await import("../dist/server.js");
  await start();
} else {
  // Everything else talks to a running Slipstream: commands, and `mcp` (stdio bridge for AI assistants).
  const { cli } = await import("../dist/cli.js");
  await cli(process.argv.slice(2));
}
