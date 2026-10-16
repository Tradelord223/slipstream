// Runs the API server and the Vite dev server together. Ctrl+C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = process.env.SLIPSTREAM_PORT ?? process.env.PORT ?? "4392";
// Developers get the invented demo mailbox; a plain `slipstream` start does not.
const env = { ...process.env, SLIPSTREAM_DEMO: "1", BROWSER: "none", SLIPSTREAM_PORT: port, SLIPSTREAM_API: `http://127.0.0.1:${port}` };

const children = [
  spawn(process.execPath, ["--watch", "server/src/main.ts"], { cwd: root, env, stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.ts"], { cwd: root, env, stdio: "inherit" }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
};
for (const c of children) c.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
console.log(`\n  Slipstream dev: app http://localhost:5180  ·  api http://127.0.0.1:${port}\n`);
