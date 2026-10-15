import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { runRules } from "../src/mail/labels.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { addAccount, makeEnv, msg, type TestEnv } from "./helpers.ts";

const acme = { name: "Ana", email: "ana@acme.test" };
const other = { name: "Bo", email: "bo@other.test" };

describe("labels and auto-label rules", () => {
  let env: TestEnv;
  let account: AccountRow;
  const run = async (command: string, input: unknown) => {
    const r = await env.api(`/api/v1/${command}`, { method: "POST", json: input });
    return { status: r.status, body: await r.json() };
  };
  const labelsOf = (remote: string) =>
    env.ctx.db
      .all<{ name: string }>("SELECT l.name FROM thread_labels tl JOIN labels l ON l.id = tl.label_id JOIN threads t ON t.id = tl.thread_id WHERE t.remote_id = ? ORDER BY l.name", remote)
      .map((r) => r.name);
  const tid = (remote: string) => env.ctx.db.get<{ id: string }>("SELECT id FROM threads WHERE remote_id = ?", remote)!.id;

  before(() => {
    env = makeEnv();
    account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID))!;
    env.ctx.store.ingest(account, {
      messages: [msg({ from: acme, remoteThreadId: "a1", subject: "Quote" }), msg({ from: other, remoteThreadId: "o1", subject: "Hello" })],
      cursor: null,
      done: true,
    });
  });
  after(() => env.cleanup());

  test("create, nest, color, count", async () => {
    assert.equal((await run("labels.create", { name: "Clients", color: "#5EE6C7" })).status, 200);
    assert.equal((await run("labels.create", { name: " Clients / Acme ", color: "#8AB4FF" })).status, 200);
    assert.equal((await run("labels.create", { name: "clients" })).status, 409, "names are case-insensitive");
    await run("triage.label", { threadIds: [tid("a1")], label: "Clients/Acme" });
    const list = (await run("labels.list", {})).body.result as { name: string; color: string; parent: string | null; count: number; unread: number }[];
    const acmeLabel = list.find((l) => l.name === "Clients/Acme")!;
    assert.deepEqual([acmeLabel.parent, acmeLabel.color, acmeLabel.count, acmeLabel.unread], ["Clients", "#8AB4FF", 1, 1]);
  });

  test("renaming a parent moves its children; delete strips the label everywhere", async () => {
    await run("labels.update", { name: "Clients", newName: "Customers", color: "#F5B544" });
    assert.deepEqual(labelsOf("a1"), ["Customers/Acme"]);
    const names = ((await run("labels.list", {})).body.result as { name: string }[]).map((l) => l.name);
    assert.deepEqual(names, ["Customers", "Customers/Acme"]);

    await run("labels.delete", { name: "Customers/Acme" });
    assert.deepEqual(labelsOf("a1"), []);
    // A later sync of the same message must not resurrect it.
    env.ctx.store.recomputeThread(tid("a1"));
    assert.deepEqual(labelsOf("a1"), []);
  });

  test("rules label new mail, leave hand-removed labels alone, and can backfill", async () => {
    const created = await run("labelRules.create", { label: "Acme", query: "from:@acme.test", applyToExisting: true });
    assert.equal(created.body.result.labelled, 1, "backfilled the existing Acme conversation");
    assert.deepEqual(labelsOf("a1"), ["Acme"]);

    await new Promise((r) => setTimeout(r, 5));
    env.ctx.store.ingest(account, { messages: [msg({ from: acme, remoteThreadId: "a2", subject: "PO" }), msg({ from: other, remoteThreadId: "o2" })], cursor: null, done: true });
    runRules(env.ctx);
    assert.deepEqual(labelsOf("a2"), ["Acme"]);
    assert.deepEqual(labelsOf("o2"), []);

    await run("triage.unlabel", { threadIds: [tid("a2")], label: "Acme" });
    runRules(env.ctx);
    assert.deepEqual(labelsOf("a2"), [], "the person's choice sticks");
  });

  test("an agent needs approval to delete a label", async () => {
    const { token } = env.ctx.agents.create(LOCAL_USER_ID, "Tidy", ["read", "triage"]);
    const r = await env.api("/api/v1/labels.delete", { method: "POST", json: { name: "Acme" }, headers: { authorization: `Bearer ${token}`, "x-slipstream": "0" } });
    assert.equal(r.status, 202);
  });
});
