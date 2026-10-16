#!/usr/bin/env node
// `slipstream` — runs Slipstream locally at http://127.0.0.1:4380. `slipstream <command>` and `slipstream mcp` talk to it.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Slipstream needs Node.js 22.18 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
// `--demo` turns on the invented demo mailbox (developers); it is a server setting, so set it before the server loads.
const args = process.argv.slice(2).filter((a) => a !== "--demo");
if (args.length !== process.argv.length - 2) process.env.SLIPSTREAM_DEMO = "1";
const sub = args[0];
if (!sub || sub === "serve") {
  const { start } = await import("../dist/server.js");
  await start();
} else {
  // Everything else talks to a running Slipstream: commands, and `mcp` (stdio bridge for AI assistants).
  const { cli } = await import("../dist/cli.js");
  await cli(args);
}
