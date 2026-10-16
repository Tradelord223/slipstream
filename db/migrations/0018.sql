-- Generated from server/src/db/schema.ts (migration 18). Edit there, then run: npm run schema:export
-- A job that must run once per install, such as trimming the mail cache after the sync stopped downloading everything.
  -- The row is written when the job finishes, so one that was interrupted starts again.
  CREATE TABLE maintenance (
    task TEXT PRIMARY KEY,
    ran_at INTEGER NOT NULL
  );
