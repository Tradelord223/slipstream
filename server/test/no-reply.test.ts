import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import type { Actor } from "../src/commands/registry.ts";
import { isAutomatedSender, isNoReplyAddress } from "../src/mail/classify.ts";
import { addAccount, makeEnv, type TestEnv } from "./helpers.ts";

/** Addresses that can't take a reply: recognised, and called out when a draft is addressed to one. */

describe("isNoReplyAddress", () => {
  test("matches the no-reply family in any case, with a +tag or digits", () => {
    for (const e of [
      "no-reply@quarrystonebank.com",
      "noreply@x.test",
      "no_reply@x.test",
      "do-not-reply@x.test",
      "donotreply@x.test",
      "do_not_reply@x.test",
      "NoReply@X.test",
      "NO-REPLY@x.test",
      "noreply2@x.test",
      "noreply+abc123@x.test",
      "no-reply.billing@x.test",
      "noreply-alerts@x.test",
    ])
      assert.equal(isNoReplyAddress(e), true, e);
  });

  test("leaves look-alikes and other automated senders alone", () => {
    for (const e of ["reply@x.test", "norelpy@x.test", "noreplyhelp@x.test", "no.one@x.test", "notifications@x.test", "info@x.test", "support@x.test", "ana.noreply@x.test", "replyno@x.test", "", "noreply"])
      assert.equal(isNoReplyAddress(e), false, e);
    assert.equal(isAutomatedSender({ name: "", email: "notifications@x.test" }), true, "isAutomatedSender is unchanged");
  });
});

describe("drafts warn about no-reply recipients", () => {
  let env: TestEnv;
  let accountId: string;
  let human: Actor;
  before(() => {
    env = makeEnv();
    accountId = addAccount(env.ctx, LOCAL_USER_ID, "sam@fernpoint.test");
    human = { kind: "human", user: env.ctx.users.get(LOCAL_USER_ID)! };
  });
  after(() => env.cleanup());

  const create = async (input: Record<string, unknown>) =>
    ((await env.ctx.commands.execute(human, "drafts.create", { accountId, subject: "Hi", body: "Hello", ...input })) as { result: { id: string; warnings: string[] } }).result;

  test("drafts.create names each no-reply recipient across to, cc and bcc, once", async () => {
    const d = await create({ to: ["no-reply@quarrystonebank.com", "ana@kettleby.test"], cc: ["NoReply@quarrystonebank.com"], bcc: ["do-not-reply@x.test"] });
    assert.deepEqual(d.warnings, ["no-reply@quarrystonebank.com doesn't accept replies.", "noreply@quarrystonebank.com doesn't accept replies.", "do-not-reply@x.test doesn't accept replies."]);
    assert.ok(env.ctx.db.get("SELECT 1 AS x FROM drafts WHERE id = ?", d.id), "the draft is still made");
  });

  test("a draft to a person has no warnings", async () => {
    assert.deepEqual((await create({ to: ["ana@kettleby.test", "notifications@x.test"] })).warnings, []);
  });

  test("drafts.send reports them and still sends", async () => {
    const d = await create({ to: ["no-reply@quarrystonebank.com"] });
    const res = (await env.ctx.commands.execute(human, "drafts.send", { draftId: d.id })) as { status: string; result: { sendAt: number; warnings: string[] } };
    assert.equal(res.status, "done");
    assert.deepEqual(res.result.warnings, ["no-reply@quarrystonebank.com doesn't accept replies."]);
    assert.equal(env.ctx.db.get<{ status: string }>("SELECT status FROM drafts WHERE id = ?", d.id)!.status, "scheduled");
  });

  test("the HTTP command API carries the field", async () => {
    const r = await env.api("/api/v1/drafts.create", { method: "POST", json: { accountId, to: ["noreply@x.test"], subject: "Hi", body: "Hello" } });
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as { result: { warnings: string[] } }).result.warnings, ["noreply@x.test doesn't accept replies."]);
  });
});
