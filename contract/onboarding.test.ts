/**
 * A fresh install starts empty: the invented demo mailbox is for developers (SLIPSTREAM_DEMO=1), so a person
 * with no account lands on onboarding rather than in someone else's inbox.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { human, startServer, type Server } from "./harness.ts";

// The harness turns the demo on for its other suites; an already-running server is whatever it was started as.
const own = !process.env.SLIPSTREAM_CONTRACT_URL;

describe("first run without the demo flag", { skip: !own && "runs against its own server only" }, () => {
  let server: Server;
  before(async () => {
    server = await startServer({ env: { SLIPSTREAM_DEMO: "" } });
  });
  after(async () => server.stop());

  test("boots with no accounts and says the demo is off", async () => {
    const b = (await human(server.url)("/api/bootstrap")).body;
    assert.equal(b.features.demo, false);
    assert.deepEqual(b.accounts, []);
    assert.notEqual(b.settings.onboarded, true);
  });

  test("the onboarded setting is saved and read back", async () => {
    const h = human(server.url);
    assert.equal((await h("/api/settings", { method: "PUT", json: { onboarded: true } })).status, 200);
    assert.equal((await h("/api/bootstrap")).body.settings.onboarded, true);
  });

  test("discovery answers for a well-known address without a sign-in to anything", async () => {
    const r = await human(server.url)("/api/accounts/discover?email=someone%40gmail.com");
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, "gmail");
    assert.equal(r.body.source, "preset");
  });
});
