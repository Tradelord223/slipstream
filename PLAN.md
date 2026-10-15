# Slipstream build plan

Slipstream is an open-source, keyboard-first, local-first email client. Behavior is reverse-engineered from Superhuman's public product (shortcut sheet, help center, and a static read of its public web bundle). The code is written clean-room: no Superhuman code, copy, CSS or assets.

## Done when

1. `npx slipstream-mail` (or `npm start`) runs locally with no account. A demo inbox can be driven entirely by keyboard.
2. `.mbox` files (Google Takeout, Thunderbird, Apple Mail) and `.eml` files import into the local store. This is tested with generated mailboxes.
3. Gmail (API), Outlook/Microsoft 365 (Graph) and any IMAP/SMTP server connect. They are unit-tested against documented API shapes. Each self-hoster brings their own OAuth client, and a setup screen walks them through it.
4. Team mode works when checked headlessly with two real users: sign-up, invite, shared snippets, shared conversations with comments, assign and resolve.
5. Self-host files exist: a Dockerfile, Compose with Litestream backups, a Fly.io config (the recommended platform), and Render/Railway notes.
6. A public repo exists with README, LICENSE (AGPL-3.0), docs and screenshots, and measured performance numbers.

## Architecture

- **One Node process** (Node ≥ 22.13, TypeScript run natively) serves both the API and the web app. Storage is `node:sqlite` with FTS5. Native dependencies: none.
- **Local-first.** Every read and every triage keystroke hits SQLite. Provider writes go through `pending_actions` after an 8-second undo window. Undo cancels anything not yet sent and inverts anything already sent.
- **Providers** implement `MailProvider` (`server/src/mail/types.ts`): `sync(cursor)` pages, and `apply(action)` for archive/trash/labels/send.
  - Gmail uses `history.list`.
  - Graph uses folder delta links.
  - IMAP uses UIDs and CONDSTORE.
  - Demo and imported archives live only locally.
- **Modes.**
  - `local`: loopback only, no login, Host/Origin allowlist plus a custom-header CSRF guard.
  - `team`: password accounts (scrypt), sessions, a workspace with invites.
- **Security.**
  - Credentials are sealed with AES-256-GCM.
  - Email HTML is sanitized and rendered in a sandboxed `srcdoc` frame with a strict CSP.
  - Remote images are blocked until you allow them.
  - There are no tracking pixels.
  - AI is optional (bring your own key) and can't fetch URLs.

## Beyond Superhuman

- A unified inbox across accounts, and any IMAP server.
- Remappable shortcuts.
- No read-receipt pixels.
- Data on your own disk.
- AI that's optional and can't exfiltrate data.
- Free.
