-- Generated from server/src/db/schema.ts (migration 16). Edit there, then run: npm run schema:export
-- threads.signal held one JSON object (the top signal); it now holds a JSON array of all the latest message's signals, most important first.
  UPDATE threads SET signal = json_array(json(signal)) WHERE json_type(signal) = 'object';

  -- When the account's first full sync finished; NULL until then. Delivery tidying only touches mail that arrived after it.
  ALTER TABLE accounts ADD COLUMN first_synced_at INTEGER;
  UPDATE accounts SET first_synced_at = last_synced_at WHERE last_synced_at IS NOT NULL;

  -- 1 when an agent wrote or last changed the rule's search. Such rules never see a one-time code's mail through a text match.
  ALTER TABLE label_rules ADD COLUMN by_agent INTEGER NOT NULL DEFAULT 0;
