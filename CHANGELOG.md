# Changelog

## Unreleased

- **Search reaches all your mail.** Slipstream keeps summaries of the last 30 days, so searches now also ask each account's provider (Gmail, Outlook or your IMAP server) for older mail and for words deep in a message. Your local results appear at once; a quiet line at the end says "Searching all your mail at Gmail…", the finds merge in newest first, and **Show more** pages on. An account that can't be searched says so with **Try again**, and the others still answer. Finds are stored as ordinary conversations, summary only, and open like any other. Agents get `mail.searchAll`, which never returns a conversation with a one-time code when the search has words. See [docs/agent-api.md](docs/agent-api.md#searching-all-of-a-persons-mail).
- **Faster first sync over IMAP.** The inbox opens on headers alone, and the previews are fetched right after in one round trip instead of one per kind of message (on Gmail that was about 2.6 s each). Later pages of the first sync get their previews the same way. Sync progress now includes a `previews` stage and the rate so far, for a time-remaining estimate.
- **A real first run.** A new install opens a short setup instead of an invented mailbox. You enter your email, and Slipstream works out where it lives from the domain's own DNS, so Google Workspace and Microsoft 365 addresses on custom domains are recognised. It then walks you through the right sign-in: guided app-password steps for Gmail, iCloud, Yahoo and Fastmail, Microsoft sign-in for Outlook, or server settings only when you need them. A live count shows mail arriving, and your inbox opens as soon as the first messages land. An optional last step adds another account or chooses AI: none, your own agent, or the built-in assistant.
- **Settings → Accounts** is simpler: your accounts and one Add account button that opens the same steps.
- **The invented demo mailbox is for developers only:** `npm run dev`, `SLIPSTREAM_DEMO=1` or `slipstream --demo`. Outside developer demo mode a new install doesn't create one. If you upgrade from a version that gave you one, it is removed when you connect a real account; in developer demo mode it stays beside your real accounts.
- **"Continue with Microsoft" needs your install's Microsoft app** for now (see [docs/connect-accounts.md](docs/connect-accounts.md#register-slipstreams-microsoft-app)) until Slipstream ships its own. Google works the same way, with your install's Google app.
- **Fixed:** removing an account that had synced mail failed with an error.
- **Fixed:** removing an account while its mail file was still being imported stopped the whole server. The import now ends with a plain note, and the server keeps running. The first sync after connecting an account and each import log their own failures instead of leaving them to close Slipstream.
- **Reconnect:** an account that needs to sign in again, or couldn't sync, has a Reconnect button in Settings → Accounts, and the rail's "Reconnect" link goes to it. Gmail and Outlook start their own sign-in; a password account opens its sign-in with the address filled in, so the new password updates the same account.
- **Mail servers found in a domain's own settings** are always shown, with a short note, before you enter a password.
- **IMAP accounts remember their provider**, so iCloud, Fastmail, Yahoo, Zoho and Proton accounts are labelled as such instead of "Email account" (accounts connected before this show it after they're reconnected).
- **Two imports into one account** no longer clash: the account keeps filling until the last one ends.
- **Doctor changes nothing:** it no longer creates the data folder or leaves `-wal` and `-shm` files next to the database.
- **Fixed:** a demo mailbox left from an older version is removed at startup once you have a real account.
- **Imports finish properly:** an imported file's account is no longer marked as "first synced" before its messages have arrived, and the app reports how far an import has got after a reload.
- **Sign-in errors say which provider** (Google or Microsoft) they came from.
- **Address lookup is more careful:** only domains that Hotmail, Outlook, Live and Yahoo really run are assumed, anything else is looked up; Zoho addresses in the EU, India and Australia get their own region's servers; the limit on simultaneous lookups is per person as well as overall; and a lookup that times out is cancelled.
- **Docs:** the account steps now use the current names (**Add account**, **Continue with Google**, **Continue with Microsoft**, **Import a mail file**), and the Google Workspace app password note follows Google's own help.
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
