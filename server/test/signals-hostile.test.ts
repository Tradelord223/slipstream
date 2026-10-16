import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LOCAL_USER_ID } from "../src/auth/users.ts";
import { detectSignals, extractCode, maskCodes } from "../src/mail/signals.ts";
import type { AccountRow } from "../src/mail/store.ts";
import { addAccount, makeEnv, msg } from "./helpers.ts";

const detect = (subject: string, text: string, isBulk: boolean) =>
  detectSignals({ subject, text, fromEmail: "x@example.test", fromName: "", isBulk, sentAt: 0 });
const spaces = (n: number) => " ".repeat(n);

/** Shapes that make a backtracking regex or a rescanning loop take seconds. Each name says what it aims at. */
const bodies: [string, string, string][] = [
  ["tracking label then a long run of spaces", "Order update", `tracking number${spaces(3000)}?`],
  ["a tracking label repeated", "Order update", "tracking id ".repeat(1000)],
  ["keywords followed by a long capital run", "Hi", `${"OTP ".repeat(100)}${"A".repeat(11_500)}`],
  ["a keyword, then capitals and digits in a long run", "Hi", `your code is ${"A1".repeat(5000)}`],
  ["a keyword on every line", "Hi", "verification code\n".repeat(700)],
  ["a long run of digits next to a keyword", "Hi", `security code ${"1234567890".repeat(1000)}`],
  ["a carrier label then whitespace", "Shipped", `carrier${spaces(4000)}x`],
  ["a carrier label repeated", "Shipped", "shipped via ".repeat(1000)],
  ["a long line that looks like a quote header", "Re: hi", `On ${"x".repeat(11_000)} wrote:`],
  ["deadline words repeated", "Hi", "deadline ".repeat(1300)],
  ["whitespace between label words", "Hi", `order${spaces(5000)}number${spaces(5000)}`],
  ["a body far longer than anyone reads", "Hi", `${"OTP A1B2C3D4 ".repeat(100_000)}`],
];
const subjects: [string, string][] = [
  ["a long subject of keywords", "code ".repeat(20_000)],
  ["a long subject of capitals", `OTP ${"Z9".repeat(50_000)}`],
  ["a long subject of spaces", `tracking number${spaces(100_000)}?`],
];

const elapsed = (fn: () => unknown) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

// Before the fix these inputs took 7 to 25 seconds; 250 ms leaves room for a busy CI machine and still catches that.
describe("hostile input can't stall the server", () => {
  for (const [name, subject, text] of bodies)
    for (const bulk of [false, true])
      test(`${name} (${bulk ? "bulk sender" : "person"}) is read in under 250 ms`, () => {
        const ms = elapsed(() => {
          detect(subject, text, bulk);
          extractCode(subject, text);
          maskCodes({ subject, text });
        });
        assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`);
      });

  for (const [name, subject] of subjects)
    test(`${name} is read in under 250 ms`, () => {
      const ms = elapsed(() => {
        detect(subject, "Hi", false);
        extractCode(subject, "Hi");
        maskCodes({ subject });
      });
      assert.ok(ms < 250, `took ${ms.toFixed(1)} ms`);
    });

  test("ingesting each of them takes under 200 ms", () => {
    const env = makeEnv();
    try {
      const account = env.ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", addAccount(env.ctx, LOCAL_USER_ID))!;
      const from = { name: "Ana", email: "ana@acme.test" };
      [...bodies, ...subjects.map(([name, subject]): [string, string, string] => [name, subject, "Hi"])].forEach(([name, subject, text], i) => {
        const ms = elapsed(() => env.ctx.store.ingest(account, { messages: [msg({ from, remoteThreadId: `h${i}`, subject, bodyText: text })], cursor: null, done: true }));
        assert.ok(ms < 200, `${name}: ${ms.toFixed(1)} ms`);
      });
    } finally {
      env.cleanup();
    }
  });
});
