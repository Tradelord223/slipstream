-- Generated from server/src/db/schema.ts (migration 10). Edit there, then run: npm run schema:export
ALTER TABLE cloud_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'managed:anthropic';
  ALTER TABLE cloud_runs ADD COLUMN model TEXT;
  ALTER TABLE cloud_runs ADD COLUMN agent_id TEXT;
  ALTER TABLE cloud_runs ADD COLUMN state TEXT;
  ALTER TABLE cloud_routines ADD COLUMN engine TEXT;
