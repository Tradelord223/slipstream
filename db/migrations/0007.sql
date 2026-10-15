-- Generated from server/src/db/schema.ts (migration 7). Edit there, then run: npm run schema:export
ALTER TABLE approvals ADD COLUMN thread_ids TEXT NOT NULL DEFAULT '[]';
