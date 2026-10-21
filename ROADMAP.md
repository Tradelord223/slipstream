# Roadmap

## Where Slipstream is

- **Mail.**
  - Providers: Gmail (API), Outlook/Microsoft 365 (Graph), any IMAP/SMTP server, and `.mbox`/`.eml` import.
  - Storage: a local SQLite store with full-text search.
  - Triage: local and instant, with real undo.
  - Organizing: split inbox, reminders, follow-ups, Send Later, Undo Send, snippets, Instant Intro, and labels with auto-label rules.
- **People.** A keyboard-first web dashboard for desktop and mobile. Team mode adds shared snippets, shared conversations, comments and assignment.
- **Agents.**
  - One command registry, exposed over HTTP (`/api/v1`, OpenAPI), MCP (HTTP and stdio), a CLI and webhooks.
  - Agents are principals with scopes and approval policies. Every action is recorded, and everything can be undone.
  - Remote MCP: an OAuth 2.1 server for claude.ai and ChatGPT, and Tailscale Serve/Funnel sharing.
  - A managed cloud agent (Claude on Managed Agents) with routines and budgets.
  - Agents on any model: Sign in with ChatGPT, your own Claude Code or Codex, or Claude, OpenAI, Gemini and OpenRouter keys.
  - Autopilot: new mail sorted as it arrives, with reasons, undo, drafted replies, learning from corrections, and an eval harness with prompt-injection cases.
- **Tests.**
  - Unit tests for the server.
  - A black-box contract suite, `contract/`, covering the agent API, MCP, OAuth and the dashboard API in local and team mode.
  - Rust tests for the IMAP crate.

## Next

1. **A Rust core and a single binary.** We measured a prototype of the hot path against the same 50,000-message database. It used about 4 MB of memory at idle (the Node server uses about 100 MB) and gave a first response after 36 ms (Node takes 256 ms), in a 2.5 MB binary. Per-action latency was already in the low milliseconds, so the gain is footprint, startup, distribution, and embedding through UniFFI and Tauri.
   - Done: `crates/slipstream-imap` (IMAP/SMTP, Gmail extensions, STARTTLS-required), 65 tests.
   - Next: `slipstream-core` (store, search, triage, commands) and `slipstream` (axum HTTP, MCP via `rmcp`, OAuth, embedded web app). The schema is shared through `db/migrations/*.sql`.
   - Gate: the same `contract/` suite, run with `SLIPSTREAM_CONTRACT_URL` against the Rust server.
2. **A desktop app.** A Tauri 2 shell around the same web app, with the core running in-process.
3. **Real-server CI for providers.** A Dovecot container plus smoke-test accounts for Gmail, Outlook, Fastmail and iCloud. Today the connectors are tested against fixtures and in-process test servers.
4. **Mobile.** UniFFI bindings for Swift and Kotlin once the Rust core exists.

## Not verified yet

- Live Gmail and Microsoft OAuth sign-in. This needs each installer's own OAuth app.
- Sending from Gmail aliases and Outlook aliases. Gmail's alias list is read with the access Slipstream already asks for, but nobody has sent real mail from an alias yet. Outlook (Microsoft Graph) sending from an alias isn't confirmed for personal accounts, so Outlook and IMAP aliases are added by hand.
- Tailscale Funnel on a real tailnet.
- The cloud agent against the live Managed Agents API. Tests use a local stand-in.
- Every engine against its live provider: ChatGPT sign-in and the four API keys. Tests use stand-ins for each API and scripted CLIs that call Slipstream's real MCP endpoint. Real Claude Code (2.1.304) and Codex (0.163.0) were checked on 2026-10-20 against the demo mailbox: each searched, read, marked done, drafted and undid; the server's activity log and Review queue confirmed every action, the sends waited for approval, and one-time codes stayed masked. Real mail accounts weren't part of that check.
- Autopilot on the API-key engines. On 2026-10-21, with 0.5.0's categories, `scripts/eval-autopilot.ts` scored real Claude Code at 37 of 37 with no injection misses. On 2026-10-20 (47 invented cases) it scored real Claude Code at 36 of 37 sorting decisions with every reply-needed and label right and no injection misses, and real Codex at 35 of 37 with one injection miss: it drafted (didn't send) a reply to a wire-fraud phish. The API-key engines haven't been measured.
- Everyday helpers on real inboxes. The code, delivery, sign-in and urgent rules are tested on about a hundred written examples, including look-alikes that must not match, but not yet on years of real mail.
- Company logos against real company sites. The fetcher is tested against local stand-ins only.
