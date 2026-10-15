/**
 * Schema migrations. Append-only: never edit a shipped migration, add a new one.
 * Times are integer milliseconds since epoch. JSON columns hold small arrays/objects.
 */
export const migrations: string[] = [
  /* 1: core */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE memberships (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );

  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT COLLATE NOCASE,
    role TEXT NOT NULL DEFAULT 'member',
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('gmail','outlook','imap','demo','archive')),
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#5EE6C7',
    auth_enc TEXT,
    sync_cursor TEXT,
    sync_status TEXT NOT NULL DEFAULT 'idle',
    sync_error TEXT,
    last_synced_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, provider, email)
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '[]',
    first_message_at INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER NOT NULL DEFAULT 0,
    last_inbound_at INTEGER,
    last_outbound_at INTEGER,
    message_count INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    in_inbox INTEGER NOT NULL DEFAULT 0,
    in_sent INTEGER NOT NULL DEFAULT 0,
    in_trash INTEGER NOT NULL DEFAULT 0,
    in_spam INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'other',
    muted INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER,
    follow_up_at INTEGER,
    done_at INTEGER,
    reminded_at INTEGER,
    -- list order: last message time, bumped when a reminder brings the thread back
    sort_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (account_id, remote_id)
  );
  CREATE INDEX threads_inbox ON threads (in_inbox, sort_at DESC);
  CREATE INDEX threads_account_recent ON threads (account_id, sort_at DESC);
  CREATE INDEX threads_recent ON threads (sort_at DESC);
  CREATE INDEX threads_snoozed ON threads (snoozed_until) WHERE snoozed_until IS NOT NULL;
  CREATE INDEX threads_follow ON threads (follow_up_at) WHERE follow_up_at IS NOT NULL;

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    message_id_header TEXT,
    in_reply_to TEXT,
    refs TEXT,
    from_name TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    subject TEXT NOT NULL DEFAULT '',
    sent_at INTEGER NOT NULL,
    snippet TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    body_html TEXT,
    unread INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    in_inbox INTEGER NOT NULL DEFAULT 0,
    in_trash INTEGER NOT NULL DEFAULT 0,
    in_spam INTEGER NOT NULL DEFAULT 0,
    outgoing INTEGER NOT NULL DEFAULT 0,
    list_unsubscribe TEXT,
    is_bulk INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, remote_id)
  );
  CREATE INDEX messages_thread ON messages (thread_id, sent_at);
  CREATE INDEX messages_msgid ON messages (account_id, message_id_header);

  CREATE VIRTUAL TABLE messages_fts USING fts5 (
    subject, body, sender, recipients,
    content='', contentless_delete=1, tokenize='porter unicode61 remove_diacritics 2'
  );

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    content_id TEXT,
    inline INTEGER NOT NULL DEFAULT 0,
    remote_id TEXT,
    blob_sha256 TEXT
  );
  CREATE INDEX attachments_message ON attachments (message_id);

  CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'user',
    color TEXT,
    UNIQUE (account_id, remote_id)
  );
  CREATE TABLE thread_labels (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (thread_id, label_id)
  );
  CREATE INDEX thread_labels_label ON thread_labels (label_id);

  CREATE TABLE contacts (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    sent_count INTEGER NOT NULL DEFAULT 0,
    received_count INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    vip INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, email)
  );

  CREATE TABLE pending_actions (
    id INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    undo_group TEXT,
    run_after INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pending_due ON pending_actions (status, run_after);
  CREATE INDEX pending_group ON pending_actions (undo_group);

  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
    reply_to_message_id TEXT,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    send_at INTEGER,
    follow_up_days INTEGER,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed')),
    error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX drafts_due ON drafts (status, send_at);

  CREATE TABLE draft_attachments (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    blob_sha256 TEXT NOT NULL
  );

  CREATE TABLE snippets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    subject TEXT,
    body_html TEXT NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE splits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    position INTEGER NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE shared_threads (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    shared_by TEXT NOT NULL REFERENCES users(id),
    source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    assignee_id TEXT REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX shared_ws ON shared_threads (workspace_id, updated_at DESC);

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    shared_thread_id TEXT NOT NULL REFERENCES shared_threads(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_thread ON comments (shared_thread_id, created_at);

  CREATE TABLE settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  /* 2: per-message labels, so a label removed at the provider leaves the thread */ `
  ALTER TABLE messages ADD COLUMN label_ids TEXT;
  `,
  /* 3: every provider copy of a message (IMAP Inbox + Sent, Gmail All Mail + Trash), so moves keep the thread */ `
  CREATE TABLE message_locations (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    inbox INTEGER NOT NULL DEFAULT 0,
    trash INTEGER NOT NULL DEFAULT 0,
    spam INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, remote_id)
  );
  CREATE INDEX message_locations_message ON message_locations (message_id);
  INSERT INTO message_locations (account_id, remote_id, message_id, inbox, trash, spam)
    SELECT account_id, remote_id, id, in_inbox, in_trash, in_spam FROM messages;
  -- Set when a message's last copy disappears; purged at the end of the sync round unless a copy reappears.
  ALTER TABLE messages ADD COLUMN orphaned_at INTEGER;
  `,
  /* 4: agents as principals, an activity record for every action, approvals, webhooks */ `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    scopes TEXT NOT NULL,
    policy TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX agents_user ON agents (user_id);

  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    command TEXT NOT NULL,
    summary TEXT NOT NULL,
    thread_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK (status IN ('done','pending','rejected','failed','undone')),
    undo_token TEXT,
    inverse TEXT,
    approval_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activity_user ON activity (user_id, created_at DESC);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    command TEXT NOT NULL,
    input TEXT NOT NULL,
    preview TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed','expired')),
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX approvals_user ON approvals (user_id, status, created_at DESC);

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    events TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_status INTEGER,
    last_error TEXT,
    last_delivery_at INTEGER
  );

  ALTER TABLE comments ADD COLUMN agent_name TEXT;
  `,
  /* 5: remote MCP over OAuth 2.1 (claude.ai, ChatGPT): clients, pending connections, short-lived tokens */ `
  ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE agents ADD COLUMN oauth_client_id TEXT;

  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    metadata_url TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state TEXT,
    scopes TEXT NOT NULL,
    resource TEXT,
    pairing_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','used','expired')),
    code_hash TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    access_hash TEXT NOT NULL UNIQUE,
    refresh_hash TEXT NOT NULL UNIQUE,
    access_expires_at INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
  /* 6: the managed cloud agent (Claude Managed Agents): runs and routines */ `
  CREATE TABLE cloud_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT,
    routine_id TEXT,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('starting','running','done','failed','budget','stopped')),
    transcript TEXT NOT NULL DEFAULT '[]',
    tool_calls INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX cloud_runs_user ON cloud_runs (user_id, created_at DESC);

  CREATE TABLE cloud_routines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    trigger TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_checked_at INTEGER,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
  /* 7: approvals know which conversations they touch */ `
  ALTER TABLE approvals ADD COLUMN thread_ids TEXT NOT NULL DEFAULT '[]';
  `,
  /* 8: auto-label rules */ `
  CREATE TABLE label_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    query TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX label_rules_user ON label_rules (user_id);
  CREATE INDEX labels_name ON labels (account_id, name COLLATE NOCASE);
  `,
];
