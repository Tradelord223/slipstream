#!/usr/bin/env node
process.env.CLI_KIND = "codex";
await import("./scripted-cli.mjs");
