-- Generated from server/src/db/schema.ts (migration 6). Edit there, then run: npm run schema:export
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
