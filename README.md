<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/brand/wordmark-dark.svg">
    <img src="https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/brand/wordmark-light.svg" alt="Slipstream" width="360">
  </picture>
</p>

<p align="center"><strong>Your own Claude Code or Codex can run your inbox.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/slipstream-mail"><img src="https://img.shields.io/npm/v/slipstream-mail?label=npm&color=0b7f66" alt="npm version"></a>
  <a href="https://github.com/Tradelord223/slipstream/actions/workflows/ci.yml"><img src="https://github.com/Tradelord223/slipstream/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Tradelord223/slipstream/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-0b7f66" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-0b7f66" alt="Node.js 22.18 or newer">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-it-does">Features</a> ·
  <a href="#built-for-agents">Agents</a> ·
  <a href="#run-it-for-a-team">Self-host</a> ·
  <a href="#privacy-and-security">Privacy</a> ·
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/inbox-dark.png" alt="The Slipstream inbox: a split inbox with one-key triage" width="900">
</p>

Slipstream is an open-source email client that your own Claude Code or Codex can run for you. It works with Gmail, Outlook and any IMAP server, and it runs on your own computer, with your mail in a local database. Each agent has its own token and permissions, anything it wants to send waits for your approval, and most of what it does can be undone.

It is also a fast, keyboard-first client for you: every keystroke is instant, and it runs on your laptop or on your team's own server. If you don't want AI at all, it stays out of your way.

## Quick start

```bash
npx slipstream-mail
npx slipstream-mail connect claude
```

The first line opens Slipstream at <http://127.0.0.1:4380> with a short setup: enter your email, follow the steps for your provider, and your inbox opens while the rest of your mail arrives. The second line, run in another terminal, prints the command that adds Slipstream to Claude Code; use `connect codex` for Codex, or add `--run` to have Slipstream run the command for you. There is no token to copy: the first time Claude Code uses the connection, Slipstream creates an agent for it, "Local MCP", which appears in Settings → Agents. It can read, triage, draft and send, and its sends wait in **Review** until you approve them. Slipstream has to be running while Claude Code or Codex uses it; "Keep it running" below makes that automatic.

Slipstream needs Node.js 22.18 or newer. To have a `slipstream` command instead of `npx slipstream-mail`, install it once with `npm install -g slipstream-mail`. If anything seems off, `npx slipstream-mail doctor` checks the install and tells you what to fix.

### Keep it running

To have Slipstream start when you log in and start again if it ever stops, stop it with Ctrl-C and run:

```bash
npx slipstream-mail service install
```

This works on macOS and Linux. `service status` shows whether it is running and where its log is, `service uninstall` removes it, and running `service install` again after an upgrade moves the service to the new version. To give Slipstream its own window and Dock icon, open <http://127.0.0.1:4380> in Chrome and use the **Install** button in the address bar, or in Safari choose **File → Add to Dock**.

## Why Slipstream

Slipstream is built so that an agent can work your inbox without taking it over.

- **Your own agent.** Claude Code or Codex, signed in with your own account, works through the same commands you do.
- **Permissions for each agent.** Every agent has its own token and scopes: read, triage, draft, send and settings. Revoking one cuts it off at once.
- **Approval before anything is sent.** Sending waits in Review by default, and so do large bulk deletes and settings changes.
- **Undo.** Every agent action is attributed to the agent by name, and most can be undone. A send can be cancelled within the undo window.
- **No code harvesting.** One-time codes are masked in the mail agents read.

Underneath, it is a fast, private email client. One key finishes a conversation, your mail stays on your disk, and remote images and tracking pixels stay blocked until you allow them.

|  | Slipstream |
|---|---|
| Mail providers | Gmail, Outlook / Microsoft 365, iCloud, Fastmail, Yahoo, Proton Bridge, any IMAP server, plus `.mbox` / `.eml` import |
| Where your mail lives | A SQLite file on your disk (or your team's server) |
| Credentials | Encrypted locally with AES-256-GCM |
| Inboxes | One unified inbox across every account, or one at a time |
| Tracking | None. Remote images and tracking pixels are held back until you choose to see them |
| Hostile email | Cleaned, then shown in a frame that can't run scripts. `npm run test:render` renders 19 hostile emails and fails if any reach the network |
| AI | Off until you turn it on. Bring your own agent over MCP or the CLI, or let agents and Autopilot run on your ChatGPT plan, your own Claude Code or Codex, or your key for Claude, OpenAI, Gemini or OpenRouter. Quick summaries use a Claude key |
| Agents | MCP, HTTP API, CLI and webhooks, with scoped tokens, approvals, attribution and undo |
| Price | Free, AGPL-3.0 |

## What it does

**Get through mail fast**

- **Triage with one key.** `E` done, `H` remind me, `#` trash, `S` star, `U` unread, `J`/`K` to move, `Z` to undo anything. `Cmd+K` finds every command; `?` shows every shortcut, and every one is remappable.
- **Split Inbox.** Important (people), Updates, Promotions and Social out of the box, sorted on your computer with no AI, and every conversation says why it is where it is. `Shift+I` moves a sender's mail to another tab for good, and `Shift+N` turns the conversation in front of you into a split. Add splits for VIPs, a client, a project, anything you can search for; Slipstream suggests them from your own mail.
- **Remind Me.** Type "tomorrow 9am" or "next week". The conversation leaves your inbox and comes back to the top when it's time, or as soon as someone replies.
- **Get Me To Zero.** Clear the whole backlog, or everything older than a week or a month, in one undoable step.
- **One-key unsubscribe.** `Cmd+U` unsubscribes and files the newsletter.
- **Search that's instant and offline.** Full-text search with `from:`, `to:`, `has:attachment`, `is:unread`, `is:code`, `is:delivery`, `after:`, `label:` and more, over everything you've synced or imported. Older mail and words deep inside a message are found by your provider's own search, which runs alongside and merges in.

**Everyday helpers, no AI needed**

- **Sign-in codes, one key away.** A Copy chip appears right in the list, and `Shift+C` copies the code without opening the email.
- **Package updates that don't pile up.** Each update shows its status. When a newer one arrives, the older ones step out of your inbox, and you can undo it.
- **Mail that matters doesn't drown.** Sign-in alerts and urgent mail from people, like legal notices, overdue bills and deadlines, get flagged. Turn each helper on or off in Settings → Helpers.

**Write and send**

- **Send Later, Undo Send, follow-up reminders.** Schedule mail, take it back within ten seconds, and get nudged if nobody replies in three days.
- **Send from any of your addresses.** Gmail aliases appear on their own. Add custom-domain, Outlook and IMAP addresses by hand, each with its own name, reply-to and signature. Replies go out from the address the email was sent to.
- **Snippets with variables.** Type `;` in a draft to insert one; `{first_name}` fills itself in. Share them with your team.
- **Instant Intro.** On an introduction, `Cmd+Shift+I` thanks the introducer and moves them to Bcc.

**Organize and share**

- **Labels.** Colors, nesting ("Clients/Kettleby"), and auto-label rules that file new mail as it arrives. Labels you apply sync to Gmail labels, Outlook categories and IMAP keywords; renames and deletes sync to Gmail.
- **Teams.** Shared snippets, shared conversations with comments, assignment and resolve, invite links. Everyone's own mailboxes stay private.
- **Company logos, if you want them.** Off by default. When on, Slipstream fetches each company's logo itself, at a random time about once a month, never from your browser and never tied to a message.

**AI, only if you want it**

- **Off by default.** Slipstream works fully without AI, and the assistant stays hidden until you turn it on. Then you get one-key summaries and reply suggestions, the assistant sidebar and Autopilot.
- **Autopilot.** New mail is sorted as it arrives: what needs you stays, receipts and notices are labelled and cleared, later things come back when they matter, and replies are drafted in your voice for you to send. Every decision shows its reason and can be undone, and it learns from what you change. It can't send. See [docs/autopilot.md](https://github.com/Tradelord223/slipstream/blob/main/docs/autopilot.md).
- **Any model you already have.** Sign in with ChatGPT, use your own Claude Code or Codex, or paste a Claude, OpenAI, Gemini or OpenRouter key. Pick per conversation; every model works through the same commands, approvals and undo. See [docs/models.md](https://github.com/Tradelord223/slipstream/blob/main/docs/models.md).
- **A cloud agent with one API key.** Paste an Anthropic key and Claude works your inbox on Anthropic's Managed Agents, through Slipstream's own actions. Ask it anything, or give it routines ("weekdays at 8: triage and draft replies", "when client mail arrives: draft a reply"). It has hard budgets per run and per month, and sending still waits for you.

## Built for agents

Every action in Slipstream is a command your agents can call: over MCP (Claude Code, Claude Desktop, Cursor), over `/api/v1` with an OpenAPI spec, from the `slipstream` CLI, or on webhooks.

- **Scoped tokens.** Each agent gets only the scopes you choose.
- **Review queue.** Sending waits in **Review** for your approval.
- **Attribution and undo.** Every agent action shows up under the agent's name, and most can be undone. A send can be cancelled within the undo window.
- **No code harvesting.** One-time codes are masked in the mail agents read, so an injected instruction can't make an agent read one out.

```bash
# Claude Code, Cursor and other HTTP MCP clients (token from Settings → Agents)
claude mcp add --transport http slipstream http://127.0.0.1:4380/mcp \
  --header "Authorization: Bearer ss_agent_…"

# Or from any script
slipstream mail.search --query "is:unread from:@client.com" --limit 5
```

**claude.ai and ChatGPT, without hosting.** Turn on Tailscale Funnel from Settings and paste the MCP URL into claude.ai or ChatGPT. You approve the connection in Review with a pairing code. Only the MCP endpoint is ever exposed, never your inbox UI. Full guide: [docs/agent-api.md](https://github.com/Tradelord223/slipstream/blob/main/docs/agent-api.md).

## See it

| | |
|---|---|
| ![First run: connect your email before anything else](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/onboarding-dark.png) | ![Gmail in three guided steps with an app password](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/onboarding-gmail-dark.png) |
| ![Everyday helpers: copy a sign-in code, see a package's status, spot sign-in alerts](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/helpers-dark.png) | ![A one-time code, ready to copy with Shift+C](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/code-dark.png) |
| ![Autopilot: every new conversation sorted, with its reason](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/autopilot-dark.png) | ![Models & accounts: ChatGPT, Claude Code, Codex or your own keys](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/models-dark.png) |
| ![The assistant in the sidebar, working on the open conversation](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/assistant-dark.png) | ![Review: approve or reject what agents want to do](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/review-dark.png) |
| ![The cloud agent: chats, routines and budget](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/agent-dark.png) | ![Labels with colors, nesting and auto-label rules](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/labels-dark.png) |
| ![Conversation](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/thread-dark.png) | ![Compose with snippets](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/compose-dark.png) |
| ![Remind me](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/remind-dark.png) | ![Command palette](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/palette-dark.png) |
| ![Privacy & safety: what's stored where and what any model sees](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/privacy-dark.png) | ![Send from your aliases and custom domains](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/settings-accounts-dark.png) |
| ![Connect an assistant over MCP](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/connect-dark.png) | ![Light theme](https://raw.githubusercontent.com/Tradelord223/slipstream/main/docs/screenshots/inbox-light.png) |

## Connect your mail

Settings → Accounts. Gmail works in two minutes with an app password over IMAP. Google and Microsoft OAuth take a one-time setup, because each install brings its own OAuth app. Full guide: [docs/connect-accounts.md](https://github.com/Tradelord223/slipstream/blob/main/docs/connect-accounts.md).

## Run it for a team

```bash
fly launch --no-deploy --copy-config
fly volumes create slipstream_data --size 3
fly secrets set SLIPSTREAM_SECRET="$(openssl rand -base64 32)"
fly deploy
```

Fly.io is the recommended host: one always-on machine with a volume, about $4 a month at October 2026 prices. Docker Compose works on any server (the compose file is 19 lines), and Render and Railway configs are included. Continuous backups go to any S3-compatible bucket with Litestream, and `slipstream doctor` checks the whole setup in one go. See [docs/self-hosting.md](https://github.com/Tradelord223/slipstream/blob/main/docs/self-hosting.md).

## Fast, measured

50,000 messages (16,667 conversations) in a local store, Apple Silicon laptop, `npm run bench`:

| Operation | p50 | p95 |
|---|---|---|
| Open a split (first 100 conversations) | 0.9 ms | 1.2 ms |
| Unread counts for every split | 6.9 ms | 8.1 ms |
| Full-text search, typical two-word query | 4.8 ms | 5.1 ms |
| Full-text search, worst case (a word in nearly every message) | 53 ms | 56 ms |
| Mark done and undo it (two writes) | 0.2 ms | 0.3 ms |
| Open a conversation | 0.05 ms | 0.08 ms |
| Agent: search over HTTP (`/api/v1/mail.search`, with auth) | 3.7 ms | 4.2 ms |
| Agent: search over MCP (`tools/call mail_search`) | 3.9 ms | 4.5 ms |
| Agent: whole-inbox digest in one call (`mail.digest`) | 9.8 ms | 12.2 ms |

Provider round-trips never block you: actions apply locally first and reach Gmail, Outlook or your IMAP server a few seconds later, after the undo window.

## Privacy and security

- **Nothing in an email can run code.** Messages are cleaned before you see them. Designed mail sits in a locked frame that can't run scripts, with a strict content policy behind it.
- **Images wait for you.** Remote images and tracking pixels load only when you choose. After that, only https pictures load: never fonts, style sheets or frames.
- **Your copy stays yours.** Mail stays in Slipstream's own data folder on your computer or server. Account sign-ins and keys are encrypted.
- **No surprise AI.** No model sees your mail until you turn a feature on, and then only what that feature needs.

**Settings → Privacy & safety** says all of this in plain words, and [docs/security.md](https://github.com/Tradelord223/slipstream/blob/main/docs/security.md) has the details. Found a problem? Please report it privately; see [SECURITY.md](https://github.com/Tradelord223/slipstream/blob/main/SECURITY.md).

## Documentation

| Guide | What's in it |
|---|---|
| [Connect accounts](https://github.com/Tradelord223/slipstream/blob/main/docs/connect-accounts.md) | Gmail, Outlook, IMAP, aliases and imports |
| [Agents and the API](https://github.com/Tradelord223/slipstream/blob/main/docs/agent-api.md) | MCP, the HTTP API, the CLI, webhooks, remote access |
| [Choose a model](https://github.com/Tradelord223/slipstream/blob/main/docs/models.md) | ChatGPT sign-in, Claude Code, Codex, API keys |
| [Autopilot](https://github.com/Tradelord223/slipstream/blob/main/docs/autopilot.md) | How new mail is sorted, and how to evaluate it |
| [Self-hosting](https://github.com/Tradelord223/slipstream/blob/main/docs/self-hosting.md) | Fly.io, Docker, Render, Railway, backups, settings |
| [Security](https://github.com/Tradelord223/slipstream/blob/main/docs/security.md) | Rendering, storage, encryption, what models see |
| [Architecture](https://github.com/Tradelord223/slipstream/blob/main/docs/architecture.md) | How the server, store and web app fit together |
| [How it was built](https://github.com/Tradelord223/slipstream/blob/main/docs/reverse-engineering.md) | The clean-room approach, from public material only |
| [Roadmap](https://github.com/Tradelord223/slipstream/blob/main/ROADMAP.md) | What's next, and what isn't verified yet |

## Develop

```bash
git clone https://github.com/Tradelord223/slipstream && cd slipstream
npm install
npm run dev             # server on :4392 with an invented demo mailbox + web app on :5180 (SLIPSTREAM_DEMO=1 or `slipstream --demo` elsewhere)
npm test                # server tests (node:test)
npm run test:contract   # black-box API + MCP contract suite against a live server
npm run test:render     # shows hostile email in headless Chrome and proves nothing runs or leaks
npm run typecheck
npm run build && npm start
```

- **Server:** TypeScript run directly by Node, with no build step in development. Hono for HTTP, `node:sqlite` with FTS5 for storage. No native npm dependencies: SQLite comes with Node.
- **Web app:** React and Vite, with plain CSS.

Contributions are welcome; [CONTRIBUTING.md](https://github.com/Tradelord223/slipstream/blob/main/CONTRIBUTING.md) explains how to get a change in.

## License

Slipstream is licensed under the [GNU AGPL v3.0](https://github.com/Tradelord223/slipstream/blob/main/LICENSE). Use it, run it for your company, change it.

- **Running a modified version:** if you run it for other people over a network, the AGPL asks you to offer them its source. Set `SLIPSTREAM_SOURCE_URL` so the app's source link points at your version.
- **Third-party software:** bundled software and fonts keep their own licenses, listed in `THIRD_PARTY_LICENSES.txt` in every build.
