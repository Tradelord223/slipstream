import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const mainPath = join(import.meta.dirname, "..", "src", "main.ts");
const root = mkdtempSync(join(tmpdir(), "slipstream-port-"));
const holders: Server[] = [];
after(() => {
  for (const h of holders) h.close();
  rmSync(root, { recursive: true, force: true });
});

/** Something already listening on a free loopback port, standing in for a running Slipstream. */
async function holdPort(): Promise<number> {
  const holder = createServer();
  holders.push(holder);
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  return (holder.address() as { port: number }).port;
}

/** Run the server as `slipstream` does, with only the variables set here, until it exits, prints `until`, or `ms` pass. */
function run(port: number, dataDir: string, ms: number, until?: RegExp) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(process.execPath, [mainPath], {
      env: { PATH: process.env.PATH ?? "", HOME: root, PORT: String(port), SLIPSTREAM_REMOTE_PORT: String(port + 1), SLIPSTREAM_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stop = () => {
      timedOut = true;
      child.kill("SIGTERM");
    };
    child.stdout.on("data", (d) => {
      stdout += d;
      if (until?.test(stdout)) stop();
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(stop, ms);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

describe("starting on a port that is taken", () => {
  test("exits 1 with one clear message, before anything syncs", async () => {
    const port = await holdPort();
    const dataDir = join(root, "taken");
    const res = await run(port, dataDir, 10_000);
    assert.equal(res.timedOut, false, "it exits on its own");
    assert.equal(res.code, 1);
    assert.match(res.stderr, new RegExp(`Slipstream is already running at http://127\\.0\\.0\\.1:${port}`));
    assert.match(res.stderr, /set PORT/);
    assert.doesNotMatch(res.stderr, /\n\s+at /, "no stack trace");
    assert.doesNotMatch(res.stdout, /Slipstream is running/);
    // A running copy may own this data: the loser must not open (and migrate) its database or write a key.
    const files = existsSync(dataDir) ? readdirSync(dataDir) : [];
    assert.deepEqual(files, [], "nothing is created in the data directory");
  });

  test("a free port still starts and prints the banner", async () => {
    const port = await holdPort();
    // Free the port again so the server can take it.
    await new Promise<void>((resolve) => holders.pop()!.close(() => resolve()));
    const res = await run(port, join(root, "free"), 10_000, /Slipstream is running/);
    assert.equal(res.timedOut, true, "it keeps running until stopped");
    assert.match(res.stdout, /Slipstream is running/);
  });
});
