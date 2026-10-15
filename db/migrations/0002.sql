-- Generated from server/src/db/schema.ts (migration 2). Edit there, then run: npm run schema:export
ALTER TABLE messages ADD COLUMN label_ids TEXT;
