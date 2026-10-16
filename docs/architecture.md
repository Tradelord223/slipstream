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
| Gmail API | `history.list` from a `historyId`; full resync if it expires | Gmail `threadId` | Summaries from `format=full` with a field mask that leaves out body data; a whole message is `format=raw`. Labels map to folders and labels. |
| Microsoft Graph | Per-folder delta links (Inbox, Sent, Deleted, Junk, Archive), newest first | `conversationId` | Immutable IDs; categories act as labels; send as MIME. Summaries select `bodyPreview` and the list headers, never `body`. |
| IMAP / SMTP | UIDs and UIDVALIDITY per mailbox, CONDSTORE when available | `X-GM-THRID`, else References | Summaries are the chosen headers, `BODYSTRUCTURE`, the size and the first 2 KB of the text part. Gmail IMAP extensions are used when present; Gmail's newest inbox mail is found with `X-GM-RAW in:inbox` in All Mail. |
| Archive import | none (local only) | Takeout `X-GM-THRID`, else References | `.mbox` streamed line by line. |
| Demo | in-memory seed | n/a | Contacts reply to what you send. |

**Summaries first.** A first sync downloads headers, a short preview, the size and the attachment names, never whole messages, newest first: the last 30 days, in pages of about 100. The newest 100 inbox messages go first, and the account is marked ready (`first_synced_at`) as soon as they are in, so the inbox opens in seconds; the rest of the window keeps arriving behind it, and the mark moves past each page of it as it is stored, so that history is never mistaken for news. The sync reports exact progress as events (`sync` with `progress`: `signin`, `inbox`, `recent`, `history`, `done`) and in `/api/bootstrap`.
- **Stored as summaries.** A summary row has `messages.body_state = 'none'`: `body_text` holds the preview (so search and signals have something) and `body_html` is empty. Mail you sent from Slipstream, imports and the demo are stored whole (`'cached'`).
- **Whole text on demand.** Opening a conversation calls `GET /api/threads/:id/bodies?ids=…`, which fetches the messages that only have a preview (`MailProvider.fetchBody`), stores them with `MailStore.attachBody` (search index, signals, thread row and attachment list are refreshed), and reports a message the provider can't return in `failed` rather than failing the request. The newest 50 inbox messages are fetched in the background after the first page, and again for new mail, so recent mail opens instantly and codes and deliveries are found in the full text.
- **Everything that reads whole messages fetches first:** agents (`mail.read`), summaries and drafts, team snapshots, Autopilot and the one-time-code routes. Code masking for agents is unchanged.
- **Attachment bytes** are downloaded only when one is opened (opening it fetches the message first, which gives its attachments the handles downloads use).

**Threads are recomputed, not patched.** After each sync page, `recomputeThread` rebuilds the thread's list row from its messages: subject, snippet, participants, counts, flags and category. That keeps the list query a single indexed scan.

**Splits are saved searches.** Important and Other are built from a classifier:
- **Important** is mail from people, from anyone you've written to, and from VIPs.
- **Other** splits into news (has an unsubscribe link) and notifications (automated senders).

Custom splits are any query in the search language. A thread that matches a custom split leaves Important and Other.

## Search language

`from:` `to:` `cc:` `subject:` `label:` `filename:` `has:attachment` `is:unread|read|starred|snoozed|done|muted|vip|important|unanswered|code|delivery|security|urgent` `in:inbox|sent|done|trash|spam|snoozed|all` `category:important|news|notification|other` `after:2026-01-31` `before:` `newer:7d` `older:2w` `account:me@x.com`, plus `-negation`, `a OR b` and `"exact phrases"`. Free text runs against an FTS5 index (porter stemming, diacritics folded) with prefix matching. User input is always quoted into FTS terms, so it can never inject FTS syntax.

## Everyday signals

Plain rules in `mail/signals.ts` (no model) read each incoming message once, when it is stored, and keep a short list in `messages.signals`: a one-time **code**, a **delivery** update, a new sign-in **security** alert, or **urgent** mail from a person (legal notices, overdue bills, same-day deadlines; never from bulk senders). `threads.signal` holds all of them for the latest incoming message as a JSON array, most important first (urgent, code, security, delivery), so a sign-in alert that carries a code shows under both `is:code` and `is:security`. List rows lead with the first and carry the whole list. The rules read a bounded stretch of each message (the subject's first 500 characters and the body's first 12,000) with bounded patterns, so hostile mail can't stall a sync.

A code's value is never stored or put in a signal. `GET /api/messages/:id/code` finds it again for a signed-in person, and agents and team snapshots get message text with codes masked. Masking alone would let an agent guess a code through search ("is:code 618" finds it, "is:code 619" doesn't), so for agents any search that matches message text (free words, `subject:`, `filename:`, negated or not) leaves out every conversation that has a code, in searches, splits, counts and auto-label rules an agent wrote (`label_rules.by_agent`). The text sent to a model for summaries, drafts, assistant context and routines is masked the same way.

When a newer update arrives for the same tracking number, older untouched updates in the inbox are marked done as "Slipstream" with an undo (setting `helpers.deliveries`). Only mail that arrived after its account's first sync finished counts (`accounts.first_synced_at`), so a newly connected account's history is never archived; when an older update turns up after a newer one, the older one is moved. A pass moves its watermark only after it succeeded. Mail stored before signals existed is scanned in the background at startup, and open dashboards are told which conversations changed.

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
