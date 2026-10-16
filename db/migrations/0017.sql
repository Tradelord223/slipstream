-- Generated from server/src/db/schema.ts (migration 17). Edit there, then run: npm run schema:export
-- 'cached': body_text/body_html hold the full message. 'none': only headers and the preview were fetched; the body comes from
  -- the provider when someone opens it. Everything synced before this migration has its body, so it starts as 'cached'.
  ALTER TABLE messages ADD COLUMN body_state TEXT NOT NULL DEFAULT 'cached';
  -- The provider's size for the whole message, in bytes, when it reports one.
  ALTER TABLE messages ADD COLUMN size INTEGER;
  -- When a person (or agent) last read this message; the cache keeps recently read bodies and lets older ones go.
  ALTER TABLE messages ADD COLUMN last_viewed_at INTEGER;
  CREATE INDEX messages_cached ON messages (body_state, last_viewed_at) WHERE body_state = 'cached';

  -- The IMAP preset an account was connected with (gmail, icloud, fastmail, yahoo, zoho, proton), for its label in Settings.
  ALTER TABLE accounts ADD COLUMN preset TEXT;
