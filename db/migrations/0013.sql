-- Generated from server/src/db/schema.ts (migration 13). Edit there, then run: npm run schema:export
ALTER TABLE cloud_runs ADD COLUMN allow TEXT;
  ALTER TABLE oauth_tokens ADD COLUMN run_id TEXT;
