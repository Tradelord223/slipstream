#!/usr/bin/env node
process.env.CLI_KIND = "claude";
await import("./scripted-cli.mjs");
