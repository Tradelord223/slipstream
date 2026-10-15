-- Generated from server/src/db/schema.ts (migration 4). Edit there, then run: npm run schema:export
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
