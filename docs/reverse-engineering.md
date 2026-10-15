# How Slipstream was reverse-engineered

Slipstream reproduces the *behavior* of a keyboard-first, premium email client: the speed, the triage loop, splits, reminders, snippets and team comments. The *code* is written from scratch.

## Sources (all public)

1. **The official keyboard-shortcut sheet and help-center articles.** These show which features exist, which keys trigger them, and how Remind Me, Send Later, Undo Send, Split Inbox, Snippets, Instant Intro and team comments behave.
2. **A static read of the public, unauthenticated web bundle** (the HTML and the JavaScript/CSS it loads, read October 2026). No account was used, no authenticated API was called, and no source maps were fetched. The read looked for architecture only:
   - **Storage:** mail lives in a local SQLite database in the browser, with a porter-stemmed full-text index. Rendering reads from local data, and sync happens in the background.
   - **Writes:** go to a persisted mutation queue. Each action type has an undo twin, and entries for the same object are coalesced.
   - **Gmail sync:** walks `history.list` from a cursor, with page and change caps. When the cursor is too old, it falls back to a full resync.
   - **Microsoft sync:** uses per-folder delta links and `$batch`.
   - **Server-side features:** delayed and cancelable send, reminders and send-later run on a small backend, because a browser tab can't do them alone.
3. **Public discussion** of what people wish were different:
   - price
   - no IMAP support
   - credentials held by a vendor
   - read-receipt pixels sent without the recipient's consent
   - no unified inbox
   - fixed shortcuts
   - an AI feature that was shown to leak mail through prompt injection

## What Slipstream keeps

- One-key triage (E, H, #, !, S, U), J/K movement, and G-then-X navigation.
- A Cmd+K command palette with a searchable shortcuts sheet.
- Done as a first-class state. Get Me To Zero clears a backlog in one undoable step.
- Split Inbox as saved searches, with Important and Other built in. A thread that matches a custom split leaves the built-in ones.
- Remind Me with natural-language times and presets. Follow-up reminders on sent mail fire only if nobody replies.
- Send Later. Undo Send (10 seconds). Send instantly. Send and mark done.
- Snippets with `{first_name}` variables and inline `;` insertion. Instant Intro.
- Team snippets, shared conversations with comments, assignment.
- Local-first storage with a write queue, and undo that's real (it cancels the provider write).

## What Slipstream changes

| Instead of | Slipstream does |
|---|---|
| Gmail and Microsoft 365 only | Gmail, Microsoft 365, any IMAP server, plus `.mbox` and `.eml` import |
| Credentials on a vendor's servers | Credentials encrypted on your own disk or your team's server |
| Read-receipt tracking pixels | None. Remote images are blocked by default. |
| One inbox per account | A unified inbox across accounts, filterable by account |
| Fixed shortcuts | Every shortcut is remappable |
| AI included in the subscription | Optional AI with your own key, no tools, injection-hardened |
| $30–40 per seat per month | Free and open source (AGPL-3.0) |

## Clean-room rules we followed

- No code, CSS, copy, icons, images or brand assets were copied. The reconstruction notes contain only feature names, key bindings and architecture observations.
- The design, the naming and every line of code are original.
- The research files (downloaded assets and notes) were kept outside this repository.
