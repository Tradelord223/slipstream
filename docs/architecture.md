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
| IMAP / SMTP | UIDs and UIDVALIDITY per mailbox, CONDSTORE when available | `X-GM-THRID`, else References | A page is the chosen headers, `BODYSTRUCTURE` and the size in one `FETCH`; the first 2 KB of each text part follow in a second pass, one `FETCH` that asks for every distinct text part the page needs. Gmail IMAP extensions are used when present; Gmail's newest inbox mail is found with `X-GM-RAW in:inbox` in All Mail. |
| Archive import | none (local only) | Takeout `X-GM-THRID`, else References | `.mbox` streamed line by line. |
| Demo | in-memory seed | n/a | Contacts reply to what you send. |

**Summaries first.** A first sync downloads headers, the size and the attachment names, never whole messages, newest first: the last 30 days, in pages of about 100. The newest 100 inbox messages go first, and the account is marked ready (`first_synced_at`) as soon as they are in, so the inbox opens in seconds. Nothing else stands between connecting and that page: on Gmail IMAP only the `X-GM-RAW in:inbox` search and one header `FETCH` do; the rest of the window is listed after it. The newest 50 inbox messages then come in full, in one request where the provider has one (`MailProvider.fetchBodies`; IMAP sends one `FETCH` of the sources for every 50 messages of a mailbox), and the rest of the inbox page gets previews (`MailProvider.fetchPreviews`, stored with `MailStore.attachPreview`, which updates the snippet, the search index, signals and the thread row and tells the open inbox). History is newest first, and only its newest 300 messages get previews, in one pass once they are stored; older history keeps an empty snippet until someone opens it, because on Gmail a preview costs more than a whole message and mail that old is rarely read before it is searched for. A message that has no preview has an empty snippet, never invented text. Gmail's API and Graph pages carry their previews already. The rest of the window keeps arriving behind it, and the mark moves past each page of it as it is stored, so that history is never mistaken for news. The sync reports exact progress as events (`sync` with `progress`: `signin`, `inbox`, `recent`, `previews`, `history`, `done`) and in `/api/bootstrap`. Each progress carries `rate`, the items per second so far in its stage, once something has been done, so a client can estimate the time left.
- **Stored as summaries.** A summary row has `messages.body_state = 'none'`: `body_text` holds the preview (so search and signals have something) and `body_html` is empty. Mail you sent from Slipstream, imports and the demo are stored whole (`'cached'`).
- **Whole text on demand.** Opening a conversation calls `GET /api/threads/:id/bodies?ids=…`, which fetches the messages that only have a preview (`MailProvider.fetchBody`), stores them with `MailStore.attachBody` (search index, signals, thread row and attachment list are refreshed), and reports a message the provider can't return in `failed` rather than failing the request. The newest 50 inbox messages are fetched in the background after the first page, and again for new mail, so recent mail opens instantly and codes and deliveries are found in the full text.
- **The cache has a size limit.** Summaries are always kept. Full text is kept for the newest 50 inbox messages and for what was opened recently, up to `cacheLimitMb` per person (default 100 MB, a setting). `CacheKeeper` (`server/src/mail/cache.ts`) measures the cache as the bytes of cached bodies plus the attachment files only those messages use (`octet_length` reads sizes from the row header, so it is exact and cheap), and after each sync round and soon after bodies are stored it puts the least recently viewed bodies (`last_viewed_at`, else `sent_at`) back to summaries until the cache is at 90% of the limit: `body_state = 'none'`, the preview as the text, no HTML, a search entry for the preview only. An attachment file is deleted only when no attachment, draft attachment or sender logo refers to it. Never evicted: the newest 50 inbox messages, mail sent from here that hasn't synced back, imports and the demo, since none of those can be fetched again. `slipstream doctor` shows the cache size.
- **One-time trim.** An install that grew under the old download-everything sync is brought back to those rules once, at startup, in the background (`trimOnce`, recorded in the `maintenance` table when it finishes; an interrupted run starts again): everything that can be fetched again turns back into a summary except the newest inbox messages and what was opened in the last 7 days, and attachment files nothing refers to are deleted. If that frees more than 50 MB of the database file, a `VACUUM` runs in a worker thread so the file shrinks on disk while the server keeps answering (its reads continue; a write waits for the lock, up to the 5 s busy timeout; it needs free disk about the size of what is left).
- **Everything that reads whole messages fetches first:** agents (`mail.read`), summaries and drafts, team snapshots, Autopilot and the one-time-code routes. Code masking for agents is unchanged.
- **Attachment bytes** are downloaded only when one is opened (opening it fetches the message first, which gives its attachments the handles downloads use).

**Threads are recomputed, not patched.** After each sync page, `recomputeThread` rebuilds the thread's list row from its messages: subject, snippet, participants, counts, flags and category. That keeps the list query a single indexed scan.

**Splits are saved searches.** The built-in tabs (Important, Updates, Promotions, Social, Forums) are searches on the category a classifier gives each conversation. They can be renamed, hidden, set to hide while empty and reordered, but not deleted:
- **Important** is mail from people, from anyone you've written to, and from VIPs.
- **Updates, Promotions, Social and Forums** hold the rest. Forums shows only while it holds mail. Every conversation has a category (`threads.category`: `people`, `updates`, `promotions`, `social`, `forums`) and the reason for it (`threads.category_reason`). `mail/classify.ts` `categorize()` decides: your own replies and VIPs, then your corrections (`category_rules`), then senders you have written to, then the provider's own sorting (Gmail's tabs, kept as `messages.provider_category`; Outlook's Focused counts as Important unless a machine sent it), then headers and wording, then "a person". A correction an agent made keeps the agent's name (`category_rules.created_by_*`), and its reason says so. `mail/resort.ts` sorts mail stored before 0.5.0 again, once per account, by fetching only its list headers again (`messages.headers_version` says which messages still need it).

Custom splits are any query in the search language. A thread that matches a custom split that is showing leaves the built-in tabs; a hidden custom split holds nothing back.

## Search language

`from:` `to:` `cc:` `subject:` `label:` `filename:` `has:attachment` `is:unread|read|starred|snoozed|done|muted|vip|important|unanswered|code|delivery|security|urgent` `in:inbox|sent|done|trash|spam|snoozed|all` `is:bulk|noreply` `category:people|updates|promotions|social|forums` `domain:shop.com` `list:news.shop.com` `after:2026-01-31` `before:` `newer:7d` `older:2w` `account:me@x.com`, plus `-negation`, `a OR b` and `"exact phrases"`. Free text runs against an FTS5 index (porter stemming, diacritics folded) with prefix matching. User input is always quoted into FTS terms, so it can never inject FTS syntax.

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
