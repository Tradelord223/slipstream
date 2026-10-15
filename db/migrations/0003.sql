-- Generated from server/src/db/schema.ts (migration 3). Edit there, then run: npm run schema:export
CREATE TABLE message_locations (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    inbox INTEGER NOT NULL DEFAULT 0,
    trash INTEGER NOT NULL DEFAULT 0,
    spam INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, remote_id)
  );
  CREATE INDEX message_locations_message ON message_locations (message_id);
  INSERT INTO message_locations (account_id, remote_id, message_id, inbox, trash, spam)
    SELECT account_id, remote_id, id, in_inbox, in_trash, in_spam FROM messages;
  -- Set when a message's last copy disappears; purged at the end of the sync round unless a copy reappears.
  ALTER TABLE messages ADD COLUMN orphaned_at INTEGER;
