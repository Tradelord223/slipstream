/**
 * How mail is sorted, black-box: the tabs, why a conversation is in one, fixing a wrong sort and undoing it,
 * and the suggestions for new tabs. Everything goes over HTTP like the dashboard and agents do.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { agent, human, makeAgent, startServer, type Server } from "./harness.ts";

let server: Server;
let h: ReturnType<typeof human>;

/** Mail the demo inbox doesn't have: a mailing list with a List-Id, a company that writes often, and a no-reply address. */
const LIST = { id: "weekly.marlowedispatch.io", from: "Marlowe Dispatch <hello@marlowedispatch.io>", count: 9 };
const COMPANY = { domain: "bramblefordorchards.io", from: "Brambleford Orchards <orders@bramblefordorchards.io>", count: 8 };
const NO_REPLY = { from: "Brambleford Orchards <no-reply@bramblefordorchards.io>", subject: "Your Brambleford Orchards password was changed" };

function importedMbox(): string {
  const parts: string[] = [];
  const add = (daysAgo: number, from: string, subject: string, extra: string[] = []) => {
    const n = parts.length;
    parts.push(
      [
        "From MAILER-DAEMON Thu Oct 15 10:00:00 2026",
        `From: ${from}`,
        "To: me@example.test",
        `Subject: ${subject}`,
        `Message-ID: <sorting-${n}@contract.test>`,
        `Date: ${new Date(Date.now() - daysAgo * 86_400_000).toUTCString()}`,
        "X-Gmail-Labels: Inbox",
        ...extra,
        "",
        "Hello from the contract suite.",
        "",
      ].join("\n"),
    );
  };
  for (let i = 0; i < LIST.count; i++) add(2 + i, LIST.from, `Marlowe issue ${i + 1}`, [`List-Id: Marlowe Dispatch <${LIST.id}>`, "List-Unsubscribe: <https://marlowedispatch.io/u>"]);
  for (let i = 0; i < COMPANY.count; i++) add(2 + i, COMPANY.from, `Brambleford order update ${i + 1}`);
  add(3, NO_REPLY.from, NO_REPLY.subject);
  return parts.join("\n");
}

before(async () => {
  server = await startServer();
  h = human(server.url);
  const form = new FormData();
  form.append("file", new Blob([importedMbox()]), "sorting.mbox");
  const job = await (await fetch(`${server.url}/api/import`, { method: "POST", headers: { "x-slipstream": "1" }, body: form })).json();
  assert.ok(job.accountId, "the import started");
  // The import runs in the background: wait until all of it is in.
  const total = LIST.count + COMPANY.count + 1;
  let n = 0;
  for (let i = 0; i < 100 && n < total; i++) {
    n = ((await h(`/api/threads?view=search&q=${encodeURIComponent("in:all from:marlowedispatch.io OR from:bramblefordorchards.io")}&limit=200`)).body.threads as unknown[]).length;
    if (n < total) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(n, total, "the imported mail arrived");
});
after(async () => server.stop());

type Row = { id: string; subject: string; category: string; categoryReason: string | null; categoryReasonCode: string | null; participants: { email: string }[] };
const CATEGORIES = ["people", "updates", "promotions", "social", "forums"];
const inbox = async () => (await h("/api/threads?view=inbox&limit=200")).body.threads as Row[];
const tabs = async () => (await h("/api/bootstrap")).body.splits as { id: string; name: string; query: string; builtin: boolean; hidden: boolean; hideWhenEmpty: boolean; position: number }[];
const run = async (command: string, input: unknown = {}) => h(`/api/v1/${command}`, { method: "POST", json: input });

describe("sorting", () => {
  test("every conversation has one of the five categories and says why", async () => {
    const rows = await inbox();
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(CATEGORIES.includes(r.category), `${r.subject}: ${r.category}`);
      assert.ok(r.categoryReason, `${r.subject} has a reason`);
      assert.ok(r.categoryReasonCode);
    }
    const counts = (await h("/api/counts")).body;
    const boot = await tabs();
    for (const s of boot) assert.equal(typeof counts.splits[s.id].total, "number");
  });

  test("the new install's tabs, and what can be done to them", async () => {
    const boot = await tabs();
    assert.deepEqual(boot.slice(0, 5).map((s) => [s.name, s.query, s.builtin, s.hidden]), [
      ["Important", "category:people", true, false],
      ["Updates", "category:updates", true, false],
      ["Promotions", "category:promotions", true, false],
      ["Social", "category:social", true, false],
      ["Forums", "category:forums", true, false],
    ]);
    assert.deepEqual(boot.slice(0, 5).map((s) => s.hideWhenEmpty), [false, false, false, false, true], "Forums shows only while it holds mail");
    const social = boot.find((s) => s.name === "Social")!;
    assert.equal((await h(`/api/splits/${social.id}`, { method: "PUT", json: { hideWhenEmpty: true, name: "Networks" } })).status, 200);
    const changed = (await tabs()).find((s) => s.id === social.id)!;
    assert.deepEqual([changed.name, changed.hideWhenEmpty, changed.query], ["Networks", true, "category:social"]);
    assert.equal((await h(`/api/splits/${social.id}`, { method: "PUT", json: { query: "from:ana" } })).status, 400, "a built-in tab keeps its search");
    assert.equal((await h(`/api/splits/${social.id}`, { method: "DELETE" })).status, 400, "and can't be deleted");
    await h(`/api/splits/${social.id}`, { method: "PUT", json: { hideWhenEmpty: false, name: "Social" } });
  });

  test("deleting a custom tab can be undone, and it comes back in the same place", async () => {
    const made = (await h("/api/splits", { method: "POST", json: { name: "Kettleby", query: "from:@kettlebyfreight.com", hideWhenEmpty: true } })).body;
    await run("splits.update", { splitId: made.id, position: 2 });
    const del = await h(`/api/splits/${made.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.ok(del.body.activityId);
    assert.ok(!(await tabs()).some((s) => s.id === made.id));
    assert.equal((await h(`/api/v1/activity/${del.body.activityId}/undo`, { method: "POST" })).status, 200);
    const back = (await tabs()).find((s) => s.name === "Kettleby")!;
    assert.deepEqual([back.position, back.hideWhenEmpty, back.query], [2, true, "from:@kettlebyfreight.com"]);
    await h(`/api/splits/${back.id}`, { method: "DELETE" });
  });

  test("moving a sender's mail to another category takes effect at once, shows in Activity, and undoes", async () => {
    const row = (await inbox())[0]!;
    const detail = (await h(`/api/threads/${row.id}`)).body;
    assert.equal(detail.sorting.category, row.category);
    assert.ok(detail.sorting.sender.email);
    const target = row.category === "social" ? "updates" : "social";

    const moved = await run("mail.recategorize", { threadId: row.id, scope: "sender", category: target });
    assert.equal(moved.status, 200);
    assert.ok(moved.body.result.moved >= 1);
    const after = (await h(`/api/threads/${row.id}`)).body;
    assert.equal(after.thread.category, target);
    assert.match(after.thread.categoryReason, /^You moved mail from .* here$/);
    assert.equal(after.sorting.rule.category, target);

    const rules = (await run("categoryRules.list")).body.result as { id: string; pattern: string; category: string }[];
    assert.equal(rules.length, 1);
    const entry = ((await h("/api/v1/activity?limit=5")).body.activity as { id: string; command: string; summary: string; canUndo: boolean }[]).find((a) => a.command === "mail.recategorize")!;
    assert.match(entry.summary, /^Moved mail from .* to /);
    assert.equal(entry.canUndo, true);

    assert.equal((await h(`/api/v1/activity/${entry.id}/undo`, { method: "POST" })).status, 200);
    const restored = (await h(`/api/threads/${row.id}`)).body.thread;
    assert.deepEqual([restored.category, restored.categoryReasonCode], [row.category, row.categoryReasonCode]);
    assert.deepEqual((await run("categoryRules.list")).body.result, []);
  });

  test("an agent's request to move mail waits for approval, and nothing moves before it", async () => {
    const row = (await inbox())[1]!;
    const { token } = await makeAgent(server.url, "Sorter", ["read", "settings"]);
    const a = agent(server.url, token);
    const asked = await a("/api/v1/mail.recategorize", { threadId: row.id, scope: "sender", category: "forums" });
    assert.equal(asked.status, 202);
    assert.equal(asked.body.status, "pending_approval");
    assert.equal((await h(`/api/threads/${row.id}`)).body.thread.category, row.category, "nothing moved yet");
    const item = ((await h("/api/v1/approvals")).body.approvals as { id: string; command: string; preview: string }[]).find((x) => x.command === "mail.recategorize")!;
    assert.match(item.preview, /^Move mail from \S+@\S+ to Forums$/);
    assert.equal((await h(`/api/v1/approvals/${item.id}/reject`, { method: "POST" })).status, 200);
    assert.deepEqual((await run("categoryRules.list")).body.result, []);
    // Reading the suggestions needs no approval.
    assert.equal((await a("/api/v1/splits.suggest", {})).status, 200);
  });

  test("suggestions come with a name, a search, a count and a few senders, and a dismissal removes one", async () => {
    const res = await run("splits.suggest");
    assert.equal(res.status, 200);
    const list = res.body.result.suggestions as { key: string; kind: string; name: string; query: string; count: number; senders: string[] }[];
    for (const s of list) {
      assert.ok(["list", "domain", "calendar", "receipts"].includes(s.kind));
      assert.ok(s.name && s.query && s.count >= 8 && s.senders.length <= 3, JSON.stringify(s));
    }
    const mailingList = list.find((s) => s.key === `list:${LIST.id}`);
    const company = list.find((s) => s.key === `domain:${COMPANY.domain}`);
    assert.ok(mailingList, "the mailing list is offered");
    assert.ok(company, "the company is offered");
    assert.deepEqual([mailingList.kind, mailingList.name, mailingList.query, mailingList.count], ["list", "Marlowe Dispatch", `list:"${LIST.id}"`, LIST.count]);
    assert.deepEqual([company.kind, company.name, company.query, company.count], ["domain", "Brambleford Orchards", `domain:"${COMPANY.domain}"`, COMPANY.count + 1]);
    // The list holds the same mail as its sender's company, so the company isn't offered twice.
    assert.ok(!list.some((s) => s.key === "domain:marlowedispatch.io"));
    // Searching for what a suggestion offers finds as many conversations as it says.
    for (const s of [mailingList, company]) {
      const found = (await h(`/api/threads?view=search&q=${encodeURIComponent(`in:inbox ${s.query}`)}&limit=200`)).body.threads as Row[];
      assert.equal(found.length, s.count, s.query);
    }
    assert.equal((await h("/api/splits/suggestions/dismiss", { method: "POST", json: { key: mailingList.key } })).status, 200);
    const after = (await run("splits.suggest")).body.result.suggestions as { key: string }[];
    assert.ok(!after.some((s) => s.key === mailingList.key));
    assert.ok(after.some((s) => s.key === company.key), "only the dismissed one went");
  });

  test("the search words: category, domain, list, is:bulk, is:noreply and is:unanswered", async () => {
    const search = async (q: string) => (await h(`/api/threads?view=search&q=${encodeURIComponent(q)}&limit=200`)).body.threads as Row[];
    const all = await search("in:all");
    assert.ok(all.length > 20);
    const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

    // category: every row it returns is in that category, and it returns every row that is.
    const present = CATEGORIES.filter((c) => all.some((r) => r.category === c));
    assert.ok(present.length >= 3, `the data holds several categories: ${present}`);
    for (const c of present) {
      const rows = await search(`in:all category:${c}`);
      assert.ok(rows.length > 0, c);
      assert.deepEqual(ids(rows), ids(all.filter((r) => r.category === c)), c);
    }
    assert.deepEqual(ids(await search("in:all category:important")), ids(await search("in:all category:people")));
    assert.ok((await search("in:all category:people")).length > 0);
    assert.deepEqual(ids(await search("in:all category:other")), ids(all.filter((r) => r.category !== "people")));
    // A word that names no category matches nothing (and so takes nothing away when negated).
    assert.deepEqual(await search("in:all category:promo"), []);
    assert.deepEqual(ids(await search("in:all -category:promo")), ids(all));

    // is:noreply: the imported no-reply address, and nothing else.
    const noreply = await search("is:noreply in:all");
    assert.ok(noreply.some((r) => r.subject === NO_REPLY.subject));
    assert.ok(noreply.every((r) => r.participants.some((p) => /^(no-?reply|do-?not-?reply)/i.test(p.email))));

    // is:unanswered and its negation split the mail in two, with nothing in both.
    const unanswered = await search("in:all is:unanswered");
    const answered = await search("in:all -is:unanswered");
    assert.ok(unanswered.length > 0 && answered.length > 0);
    assert.equal(unanswered.length + answered.length, all.length);
    assert.deepEqual(ids(unanswered).filter((id) => ids(answered).includes(id)), []);

    // is:bulk: the mailing list is in, a person's conversation is out.
    const bulk = await search("in:all is:bulk");
    assert.ok(bulk.length >= LIST.count);
    assert.ok(Array.from({ length: LIST.count }, (_, i) => `Marlowe issue ${i + 1}`).every((subject) => bulk.some((r) => r.subject === subject)));
    assert.deepEqual(await search("in:all is:bulk category:people"), []);

    // domain: returns the conversations from that company, not just a 200.
    const company = await search(`in:all domain:${COMPANY.domain}`);
    assert.equal(company.length, COMPANY.count + 1);
    assert.ok(company.every((r) => r.participants.some((p) => p.email.endsWith(`@${COMPANY.domain}`))));
    assert.deepEqual(ids(await search(`in:all domain:@${COMPANY.domain}`)), ids(company));
    assert.deepEqual(ids(await search(`in:all domain:mail.${COMPANY.domain}`)), ids(company), "a subdomain names the company");
    assert.ok(company.length < all.length, "it filters");

    // list: finds the list's mail by its List-Id and nothing else.
    const listed = await search(`in:all list:${LIST.id}`);
    assert.equal(listed.length, LIST.count);
    assert.ok(listed.every((r) => r.subject.startsWith("Marlowe issue")));
    assert.deepEqual(ids(await search(`in:all list:"${LIST.id}"`)), ids(listed));
    assert.deepEqual(ids(await search(`in:all list:<${LIST.id.toUpperCase()}>`)), ids(listed));
    assert.deepEqual(await search("in:all list:nothing.example.org"), []);
  });

  test("a saved tab with a typo in its category holds nothing and leaves the built-in tabs as they were", async () => {
    const tabsNow = await tabs();
    const promotions = tabsNow.find((s) => s.name === "Promotions")!;
    const inTab = async (id: string) => ((await h(`/api/threads?view=split&split=${id}&limit=200`)).body.threads as Row[]).map((r) => r.id).sort();
    const before = await inTab(promotions.id);
    assert.ok(before.length > 0);
    const made = (await h("/api/splits", { method: "POST", json: { name: "Typo", query: "category:promo" } })).body;
    assert.deepEqual(await inTab(made.id), []);
    assert.deepEqual(await inTab(promotions.id), before);
    await h(`/api/splits/${made.id}`, { method: "DELETE" });
  });
});
