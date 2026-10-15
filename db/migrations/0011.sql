-- Generated from server/src/db/schema.ts (migration 11). Edit there, then run: npm run schema:export
CREATE TABLE autopilot_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('queued','deciding','decided','failed')),
    source TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model','sender')),
    decision TEXT,
    applied INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','corrected')),
    correction TEXT,
    activity_ids TEXT NOT NULL DEFAULT '[]',
    draft_id TEXT,
    draft_body TEXT,
    run_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    UNIQUE (thread_id, message_id)
  );
  CREATE INDEX autopilot_items_user ON autopilot_items (user_id, created_at DESC);
  CREATE INDEX autopilot_items_run ON autopilot_items (run_id);

  CREATE TABLE sender_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, pattern)
  );

  ALTER TABLE cloud_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'assistant';
