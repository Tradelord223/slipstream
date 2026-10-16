# Security and privacy

Slipstream holds the keys to people's mailboxes. This page covers who it defends against and how.

## Threats and defenses

**A website you visit tries to talk to your local Slipstream.**

- **Network exposure:** local mode listens on 127.0.0.1 only.
- **DNS rebinding:** every request must carry an allowed `Host` header, or it gets a 421 response.
- **Cross-site requests:** API calls need a custom `x-slipstream` header. Browsers can't send it cross-origin without a CORS preflight, and Slipstream never approves one.
- **Origin check:** requests with a foreign `Origin` are refused.

**A malicious email tries to run code, track you, or phish through the UI.**

- **Sanitizing:** HTML bodies are sanitized with DOMPurify, which removes scripts, forms, frames and event handlers.
- **Sandboxing:** bodies render in a sandboxed `srcdoc` iframe. It has no `allow-scripts`, and its Content-Security-Policy is `default-src 'none'`.
- **Remote images:** blocked until you choose to show them. This defeats tracking pixels and IP logging.
- **Attachments:** downloads are served as `application/octet-stream` with `Content-Disposition: attachment` and a sandbox CSP. Only raster images render inline.

**A malicious email tries to hijack the AI** (prompt injection).

Assume some mail will try. Slipstream's defenses are enforced by the server, not by asking a model to behave:

- **Quick summaries and reply suggestions get no tools at all.** They can't fetch URLs, send mail or read other mail. Their output is shown as plain text, and a suggested reply only ever lands in your compose box.
- **Agents act only through Slipstream's commands,** with the scopes you gave them. Sending, bulk deletion and settings changes wait for you in Review by default, and everything else is attributed and undoable.
- **Autopilot is boxed in per run:**
  - It has its own agent with read, triage and draft access, never send.
  - A sorting run may read only the conversations in its batch and record decisions about them.
  - A drafting run may read only its conversations and reply to the people who wrote; the server sets the recipients, not the model.
  - The server refuses anything else, whatever the email says.
- **Data, not instructions:** email content (bodies, subjects, names and addresses) goes to a model as marked data with no angle brackets left in it, so it can't pose as Slipstream's own instructions.
- **Your own Claude Code or Codex** runs in an empty private folder with Slipstream's MCP server as its only tool source: Claude Code's built-in tools are off, and Codex's shell, hooks and command rules are off. Its token works only on `/mcp`, only for that turn. It sees only the environment variables it needs for its own sign-in.

**Sender logos reveal who you hear from.**

- **Off by default.** Logos show next to company senders only after you turn them on in Settings. On a team server, `SLIPSTREAM_SENDER_LOGOS=off` switches them off for everyone.
- **What is fetched, and by whom.** The computer running Slipstream (your own Mac in local mode, the server in team mode) looks for each company's icon on the company's own website, about once a month per company. Your browser never contacts those sites.
- **What a sender's site can learn.** That someone running Slipstream asked for its icon. It can't tell which message prompted it or who the message was for, and the request happens at a random time hours later, not when the mail arrives.
- **Guarded requests.** The server only makes plain https requests on port 443 and refuses any address inside your own network or the internet's reserved ranges, including after redirects. Downloaded images are checked by their contents, and SVG logos are stripped down to plain shapes before they are stored.
- **No lookups on demand.** Only senders who have actually written to you get a logo, a request for any other domain is refused, and the demo mailbox uses built-in invented logos without any network access.

**Someone gets a copy of the database.**

- **Encryption:** OAuth refresh tokens and IMAP passwords are sealed with AES-256-GCM. The key comes from `SLIPSTREAM_SECRET` or a separate 0600 key file.
- **Permissions:** data files are created owner-only (umask 077).

**Team mode: an outsider or a teammate oversteps.**

- **Sign-up:** after the first owner, joining needs an invite link. Links are single-use, expire in 14 days and can be bound to an email address.
- **Passwords:** hashed with scrypt (N=2^15). Login and sign-up attempts are rate-limited.
- **Sessions:** HttpOnly, SameSite=Lax, and Secure under HTTPS.
- **Data access:** every query is scoped to the signed-in user's own accounts. Teammates only ever see snapshots someone deliberately shared.
- **Snippets:** shared snippets can be edited only by their author.

**OAuth flows.** Slipstream uses PKCE. The `state` value is random, single-use, expires after 10 minutes and is bound to the user who started the flow.

## What Slipstream never does

- **No read receipts or tracking pixels** in mail you send.
- **No analytics, telemetry, error reporting or remote fonts.** The web app loads nothing from third parties.
- **No contact with Slipstream's authors.** There's no server to talk to.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.
