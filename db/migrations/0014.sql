-- Generated from server/src/db/schema.ts (migration 14). Edit there, then run: npm run schema:export
-- JSON array of detected signals; NULL means the message hasn't been scanned yet (backfilled at startup).
  ALTER TABLE messages ADD COLUMN signals TEXT;
  -- The top signal of the thread's latest incoming message, and when that message arrived.
  ALTER TABLE threads ADD COLUMN signal TEXT;
  ALTER TABLE threads ADD COLUMN signal_at INTEGER;
  CREATE INDEX threads_signal ON threads (signal) WHERE signal IS NOT NULL;

  -- Extra addresses an account can send as (Gmail send-as aliases, or added by hand). The account's own address isn't listed.
  CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    signature_html TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('provider','manual')),
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, email)
  );
  -- The address a draft is sent from; NULL is the account's own.
  ALTER TABLE drafts ADD COLUMN from_email TEXT;

  -- One logo per sender domain, fetched by the server and cached; 'none' rows remember a miss.
  CREATE TABLE sender_logos (
    domain TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('found','none')),
    content_type TEXT,
    blob_sha256 TEXT,
    source TEXT,
    fetched_at INTEGER NOT NULL
  );
