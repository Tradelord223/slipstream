-- Generated from server/src/db/schema.ts (migration 12). Edit there, then run: npm run schema:export
ALTER TABLE cloud_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE cloud_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
