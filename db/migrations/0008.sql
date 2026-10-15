-- Generated from server/src/db/schema.ts (migration 8). Edit there, then run: npm run schema:export
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
