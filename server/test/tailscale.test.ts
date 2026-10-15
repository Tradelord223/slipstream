import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

// A fake `tailscale` CLI that keeps Serve/Funnel state in a JSON file and logs its arguments.
const dir = mkdtempSync(join(tmpdir(), "slipstream-ts-"));
const state = join(dir, "state.json");
const log = join(dir, "calls.log");
const bin = join(dir, "tailscale");
writeFileSync(state, JSON.stringify({ Web: {}, AllowFunnel: {} }));
writeFileSync(
  bin,
  `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const key = "box.tail1234.ts.net:443";
if (args[0] === "status") { console.log(JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail1234.ts.net." } })); process.exit(0); }
if (args[0] === "serve" && args[1] === "status") { console.log(JSON.stringify(s)); process.exit(0); }
if (args.includes("off")) { delete s.Web[key]; delete s.AllowFunnel[key]; save(); process.exit(0); }
const target = args[args.length - 1];
s.Web[key] = { Handlers: { "/": { Proxy: target } } };
if (args[0] === "funnel") s.AllowFunnel[key] = true; else delete s.AllowFunnel[key];
save();
`,
);
chmodSync(bin, 0o755);
process.env.SLIPSTREAM_TAILSCALE_BIN = bin;
const { share, tailscaleState } = await import("../src/remote/tailscale.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

describe("Tailscale sharing", () => {
  test("serve, switch to funnel, turn off", async () => {
    let s = await tailscaleState(4381);
    assert.equal(s.running, true);
    assert.equal(s.dnsName, "box.tail1234.ts.net");
    assert.equal(s.serve, null);

    s = await share("serve", 4381);
    assert.deepEqual(s.serve, { url: "https://box.tail1234.ts.net" });
    assert.equal(s.funnel, null);

    s = await share("funnel", 4381);
    assert.deepEqual(s.funnel, { url: "https://box.tail1234.ts.net" });
    assert.equal(s.serve, null);

    s = await share("off", 4381);
    assert.equal(s.funnel, null);
    assert.equal(s.serve, null);
    assert.match(readFileSync(log, "utf8"), /funnel --bg --https=443 http:\/\/127\.0\.0\.1:4381/);
  });

  test("never replaces something else served on :443", async () => {
    writeFileSync(state, JSON.stringify({ Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } }, AllowFunnel: {} }));
    await assert.rejects(share("serve", 4381), /already serving something else/);
    assert.equal(JSON.parse(readFileSync(state, "utf8")).Web["box.tail1234.ts.net:443"].Handlers["/"].Proxy, "http://127.0.0.1:3000");
  });
});
