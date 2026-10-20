import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import type { Actor } from "../src/commands/registry.ts";
import { isAutomatedSender, isNoReplyAddress } from "../src/mail/classify.ts";
import { noReplyWarnings } from "../src/mail/drafts.ts";
import { noReplyNote } from "../../web/src/lib/compose.ts";
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

describe("the composer's copy of the no-reply check", () => {
  // web/src/lib/compose.ts keeps its own copy of the pattern (the web build can't import server code).
  const positives = ["no-reply@x.test", "noreply@x.test", "no_reply@x.test", "do-not-reply@x.test", "donotreply@x.test", "do_not_reply@x.test", "NoReply@X.test", "noreply2@x.test", "noreply+abc123@x.test", "no-reply.billing@x.test", "noreply-alerts@x.test"];
  const lookalikes = ["reply@x.test", "norelpy@x.test", "noreplyhelp@x.test", "no.one@x.test", "notifications@x.test", "ana.noreply@x.test", "replyno@x.test", "", "noreply"];

  test("agrees with the server on every address, and words the note the same way", () => {
    for (const email of [...positives, ...lookalikes]) {
      const addr = { name: "", email };
      assert.equal(noReplyNote([addr]) !== "", isNoReplyAddress(email), email);
      assert.equal(noReplyNote([addr]), noReplyWarnings({ to: [addr], cc: [], bcc: [] }).join(" "), email);
    }
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

  test("drafts.update reports them too", async () => {
    const d = await create({ to: ["ana@kettleby.test"] });
    const res = (await env.ctx.commands.execute(human, "drafts.update", { draftId: d.id, to: ["noreply@x.test"] })) as { result: { warnings: string[] } };
    assert.deepEqual(res.result.warnings, ["noreply@x.test doesn't accept replies."]);
    const clean = (await env.ctx.commands.execute(human, "drafts.update", { draftId: d.id, to: ["ana@kettleby.test"] })) as { result: { warnings: string[] } };
    assert.deepEqual(clean.result.warnings, []);
  });

  test("an agent's send that waits for approval shows the person the same line", async () => {
    const bot: Actor = { kind: "agent", user: human.user, agent: env.ctx.agents.create(LOCAL_USER_ID, "no-reply-bot", ["read", "draft", "send"]).agent };
    const d = await create({ to: ["no-reply@quarrystonebank.com"] });
    const res = (await env.ctx.commands.execute(bot, "drafts.send", { draftId: d.id })) as { status: string; approvalId: string };
    assert.equal(res.status, "pending_approval");
    const { preview } = env.ctx.db.get<{ preview: string }>("SELECT preview FROM approvals WHERE id = ?", res.approvalId)!;
    assert.match(preview, /^Note: no-reply@quarrystonebank\.com doesn't accept replies\.$/m);
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
