# Changelog

## Unreleased

- `slipstream doctor` checks an install without changing anything and explains each problem in plain words: Node.js, data folder permissions, disk space, database health and version, whether the encryption key still opens saved sign-ins, whether Slipstream or another program holds its port, each mail account's sync, and changes or sends that didn't go through. On team servers it also checks the https public address, backups and `SLIPSTREAM_SECRET`. `--json` for scripts and agents; exit code 1 when something needs fixing.

## 0.2.0 (2026-10-16)

**Everyday helpers, with no AI needed**
- One-time codes get a Copy chip in the list and a card in the conversation; `Shift+C` copies without opening the email. Codes are masked in everything agents and Autopilot read.
- Package updates show their status (shipped, out for delivery, delivered and more). When a newer update for the same package arrives, the older ones move to Done, and you can undo it.
- Sign-in alerts and urgent mail from people (legal notices, overdue bills, deadlines) are flagged and never moved automatically.
- New search operators: `is:code`, `is:delivery`, `is:security`, `is:urgent`. Settings → Helpers turns each helper on or off and adds matching splits in one click.

**Send from any of your addresses**
- Gmail send-as aliases are read automatically. Add custom-domain, Outlook and IMAP addresses by hand, each with its own name, reply-to and signature.
- The composer's From picker lists every address, and replies default to the address the email was sent to.
- The server checks that every From belongs to the account, for people and agents alike. Mail with your alias in its From header counts as yours only when your provider files it as sent.

**AI off by default, and a Privacy & safety page**
- The built-in assistant and Autopilot stay hidden until you turn them on in Settings → AI & agents. Off is enforced by the server: Autopilot and routines pause too, and switching back on starts from that moment rather than catching up. Your own agents can connect over MCP and the CLI either way.
- Settings → Privacy & safety says in plain words how email is shown, what is stored and encrypted, and what any model sees.
- `npm run test:render` renders 19 hostile emails in headless Chrome and fails if any run script or reach the network. It found and fixed one leak: quoted background images in replies and forwards.

**Company logos (off by default)**
- Logos for company senders, fetched by the computer running Slipstream at a random time about once a month, never by your browser. Requests are restricted to public https addresses, logos are checked by their contents and SVGs are reduced to plain shapes.

**Project**
- New README, logo, contributing guide, security policy, code of conduct and issue templates.

## 0.1.0 (2026-10-15)

First public release: a keyboard-first, local-first email client for Gmail, Outlook and any IMAP server, with split inbox, reminders, Send Later and Undo Send, snippets, labels and teams, plus agents over MCP, the HTTP API, the CLI and webhooks, a managed cloud agent, Autopilot, and agents on any model (ChatGPT sign-in, Claude Code, Codex, or Claude, OpenAI, Gemini and OpenRouter keys).
