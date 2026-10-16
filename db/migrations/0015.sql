-- Generated from server/src/db/schema.ts (migration 15). Edit there, then run: npm run schema:export
-- The registrable domain of from_email (personal providers included); '' when it has none, NULL until backfilled at startup.
  ALTER TABLE messages ADD COLUMN sender_domain TEXT;
  CREATE INDEX messages_sender_domain ON messages (sender_domain);

  -- When each person first asked for a domain's logo. The cache is shared, so a logo another person already
  -- caused to be fetched is still withheld until this person's own random delay has passed.
  CREATE TABLE logo_requests (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    first_requested_at INTEGER NOT NULL,
    serve_after INTEGER NOT NULL,
    PRIMARY KEY (user_id, domain)
  );
