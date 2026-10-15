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

- **No tools:** the model gets no tools at all. It can't fetch URLs, send mail or read other mail.
- **Data, not instructions:** email content is passed as delimited data, and forged closing tags are neutralized. The system prompt marks that content as data.
- **Plain text only:** output is shown as plain text, with no rendered links or images that could carry data out.
- **You review drafts:** a drafted reply only ever lands in your compose box.

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
