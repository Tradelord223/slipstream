# How Slipstream works

```
 Browser (React)                     Slipstream server (one Node process)              Providers
┌──────────────────┐  /api + SSE   ┌──────────────────────────────────────────┐
│ keyboard, lists, │ ────────────► │ HTTP (Hono)  ── guards: Host, Origin,    │
│ optimistic UI,   │ ◄──────────── │                 client header, session   │
│ sandboxed bodies │   events      │ Triage ──► SQLite (node:sqlite, FTS5)    │
└──────────────────┘               │   │         threads · messages · fts    │
                                   │   └─► pending_actions ──┐               │
                                   │ SyncEngine (1s tick) ◄──┘               │
                                   │   sync(cursor) pages ──► MailStore      │ ◄──► Gmail API
                                   │   apply(action)  ───────────────────────┼────► Microsoft Graph
                                   │   reminders, scheduled sends           │ ◄──► IMAP / SMTP
                                   └──────────────────────────────────────────┘
```

## Principles

**Every keystroke is local.** Reading, searching and triaging only touch SQLite. A typical split opens in about a millisecond. Mark Done is a local write of a fraction of a millisecond. Full-text search over 50,000 messages takes tens of milliseconds. See the numbers in the README.

**Provider writes wait out the undo window.** A triage action updates local state right away. It also queues the provider operation in `pending_actions`, with `run_after = now + 8s`.
- **Undo inside the window:** it cancels the queued row, so the provider never hears about it.
- **Undo after the write ran:** it queues the inverse action.
- **Sync during the window:** while a thread has queued actions, incoming sync pages can't overwrite its triage flags. That way a slow provider never makes a Done conversation jump back into the inbox.

**Providers are adapters.** `MailProvider` has two jobs, sketched below. Everything above that layer is provider-agnostic.

- **Inbound:** `sync(cursor)` returns pages of normalized messages, flag updates and deletions.
- **Outbound:** `apply(action)` performs archive, trash, labels and send.

| Provider | Sync | Threads | Notes |
|---|---|---|---|
| Gmail API | `history.list` from a `historyId`; full resync if it expires | Gmail `threadId` | Raw RFC 822 parsed locally; labels map to folders and labels. |
| Microsoft Graph | Per-folder delta links (Inbox, Sent, Deleted, Junk, Archive) | `conversationId` | Immutable IDs; categories act as labels; send as MIME. |
| IMAP / SMTP | UIDs and UIDVALIDITY per mailbox, CONDSTORE when available | `X-GM-THRID`, else References | Gmail IMAP extensions are used when present. |
| Archive import | none (local only) | Takeout `X-GM-THRID`, else References | `.mbox` streamed line by line. |
| Demo | in-memory seed | n/a | Contacts reply to what you send. |

**Threads are recomputed, not patched.** After each sync page, `recomputeThread` rebuilds the thread's list row from its messages: subject, snippet, participants, counts, flags and category. That keeps the list query a single indexed scan.

**Splits are saved searches.** Important and Other are built from a classifier:
- **Important** is mail from people, from anyone you've written to, and from VIPs.
- **Other** splits into news (has an unsubscribe link) and notifications (automated senders).

Custom splits are any query in the search language. A thread that matches a custom split leaves Important and Other.

## Search language

`from:` `to:` `cc:` `subject:` `label:` `filename:` `has:attachment` `is:unread|read|starred|snoozed|done|muted|vip|important|unanswered|code|delivery|security|urgent` `in:inbox|sent|done|trash|spam|snoozed|all` `category:important|news|notification|other` `after:2026-01-31` `before:` `newer:7d` `older:2w` `account:me@x.com`, plus `-negation`, `a OR b` and `"exact phrases"`. Free text runs against an FTS5 index (porter stemming, diacritics folded) with prefix matching. User input is always quoted into FTS terms, so it can never inject FTS syntax.

## Everyday signals

Plain rules in `mail/signals.ts` (no model) read each incoming message once, when it is stored, and keep a short list in `messages.signals`: a one-time **code**, a **delivery** update, a new sign-in **security** alert, or **urgent** mail from a person (legal notices, overdue bills, same-day deadlines; never from bulk senders). `threads.signal` holds the top one for the latest incoming message, which is what list rows and `is:code|delivery|security|urgent` use. The rules favor staying quiet over guessing.

A code's value is never stored or put in a signal. `GET /api/messages/:id/code` finds it again for a signed-in person, and agents and team snapshots get message text with codes masked. When a newer update arrives for the same tracking number, older untouched updates in the inbox are marked done as "Slipstream" with an undo (setting `helpers.deliveries`). Mail stored before this existed is scanned in the background at startup.

## Data model (SQLite)

- **`accounts`:** provider connections. Credentials are sealed with AES-256-GCM.
- **`threads`:** list rows with triage state (`in_inbox`, `snoozed_until`, `follow_up_at`, `done_at`, `category`, `sort_at`).
- **`messages` and `messages_fts`:** bodies and the contentless FTS5 index.
- **`attachments`:** metadata. Blobs live in a content-addressed store on disk.
- **`labels` and `thread_labels`, `contacts`:** recipient autocomplete, VIPs and the importance signal.
- **`pending_actions`:** the queue of provider writes.
- **`drafts` and `draft_attachments`:** compose, Undo Send and Send Later.
- **`users`, `sessions`, `workspaces`, `memberships`, `invites`:** team mode.
- **`snippets`:** personal or shared with the workspace.
- **`shared_threads` and `comments`:** team discussion on a snapshot of a conversation.
- **`splits` and `settings`:** per-user configuration.

## Modes

- **local** (default): binds to 127.0.0.1 with no login, and there's one implicit user.
- **team**: password accounts (scrypt), HttpOnly session cookies, a workspace with single-use, email-bound invite links, and per-user mail accounts. Sharing a conversation takes a snapshot that teammates can read, comment on, assign and resolve.
