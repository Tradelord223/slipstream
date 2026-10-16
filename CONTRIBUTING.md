# Contributing to Slipstream

Thanks for helping. Slipstream is a small, careful codebase: fast paths stay fast, every action an agent can take goes through one command registry, and nothing leaves your machine unless you asked for it. Changes that keep it that way are very welcome.

## Get set up

```bash
git clone https://github.com/Tradelord223/slipstream && cd slipstream
npm install
npm run dev          # server on :4392 with a demo inbox, web app on :5180
```

You need Node.js 22.18 or newer. The demo inbox is invented mail, so you can try everything without connecting a real account.

## Before you open a pull request

```bash
npm run typecheck
npm test               # server tests
npm run test:contract  # black-box API and MCP suite against a live server
npm run test:render    # hostile-email rendering proof (needs Chrome)
npm run build
cargo test --workspace # only if you touched crates/
```

CI runs the same checks. A pull request should:

- do one thing, with a title that says what changed for the person using Slipstream;
- include a test that fails without the change, for fixes and new behavior;
- update the docs in `docs/` and the README when behavior people rely on changes;
- add a migration at the end of `server/src/db/schema.ts` (never edit a shipped one) and run `npm run schema:export`;
- keep agent-facing behavior in the command registry (`server/src/commands/catalog.ts`), so the dashboard, MCP, the HTTP API and the CLI stay in step.

## Ground rules

- **Privacy first.** No telemetry, no tracking pixels, no new network calls without a setting that controls them, and a line in `docs/security.md` saying what they reveal.
- **Agents act through commands.** Scopes, approvals, attribution and undo apply to every agent action. Don't add side doors.
- **Plain words in the product.** Interface copy should make sense to someone who has never heard of IMAP.
- **Invented names in examples.** Demo data, tests and screenshots use made-up people and companies.

## Reporting bugs and ideas

Open an issue with the template that fits. For anything security-related, please follow [SECURITY.md](SECURITY.md) instead of filing a public issue.

By contributing, you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), the same license as the project.
