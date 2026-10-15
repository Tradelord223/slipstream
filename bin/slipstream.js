#!/usr/bin/env node
// `npx slipstream-mail` — runs Slipstream locally at http://127.0.0.1:4380.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Slipstream needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
if (process.argv[2] === "mcp") {
  // Mail MCP server over stdio for AI assistants (read, search, draft; never sends).
  const { startMcp } = await import("../dist/mcp.js");
  await startMcp();
} else {
  const { start } = await import("../dist/server.js");
  await start();
}
