-- Generated from server/src/db/schema.ts (migration 19). Edit there, then run: npm run schema:export
-- The List-Id of the message (lower case, no brackets), and the category its provider put it in (Gmail's Personal, Promotions,
  -- Social, Updates, Forums; Outlook's focused as 'personal' and other as 'other'). NULL when the provider says nothing.
  ALTER TABLE messages ADD COLUMN list_id TEXT;
  ALTER TABLE messages ADD COLUMN provider_category TEXT;
  -- Bulk mail's delivery chips are read again on start, now that a sale blast needs a tracking number, carrier or subject to count.
  UPDATE messages SET signals = NULL WHERE outgoing = 0 AND is_bulk = 1 AND signals LIKE '%"kind":"delivery"%';
  CREATE INDEX messages_list_id ON messages (list_id) WHERE list_id IS NOT NULL;
  -- 1 once the message was stored by code that keeps the list headers and the provider's category; 2 when the provider could no
  -- longer return it. 0 is mail stored before that, which the one-time re-sort fetches the headers of again.
  ALTER TABLE messages ADD COLUMN headers_version INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX messages_unsorted ON messages (account_id, in_inbox, sent_at) WHERE headers_version = 0 AND outgoing = 0;
  -- Why the conversation is in its category, as a short code (see mail/classify.ts); NULL until it is sorted again.
  ALTER TABLE threads ADD COLUMN category_reason TEXT;

  -- A person's correction: mail from this address ('ana@shop.com'), domain ('@shop.com') or mailing list ('list:news.shop.com') goes to a category.
  CREATE TABLE category_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('people','updates','promotions','social','forums')),
    -- Who made it, as Activity records actors: the person, or an agent and its name. The reason says so ("Helper moved mail from X here").
    created_by_kind TEXT NOT NULL DEFAULT 'human' CHECK (created_by_kind IN ('human','agent')),
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, pattern)
  );

  -- Tabs can be hidden, and can hide themselves while they hold nothing.
  ALTER TABLE splits ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE splits ADD COLUMN hide_when_empty INTEGER NOT NULL DEFAULT 0;

  -- The old categories become the new ones. The re-sort sets the real category and reason for every conversation.
  UPDATE threads SET category_reason = 'legacy', category = CASE category
    WHEN 'important' THEN 'people'
    WHEN 'news' THEN 'promotions'
    ELSE 'updates' END;

  -- is:noreply used to mean "unanswered"; it now means "from a no-reply address". Search words are read in any case, so the rewrite
  -- matches any case too, one occurrence per statement (three rounds: no saved search says it more often).
  UPDATE splits SET query = substr(query, 1, instr(lower(query), 'is:noreply') - 1) || 'is:unanswered' || substr(query, instr(lower(query), 'is:noreply') + 10)
    WHERE instr(lower(query), 'is:noreply') > 0;
  UPDATE splits SET query = substr(query, 1, instr(lower(query), 'is:noreply') - 1) || 'is:unanswered' || substr(query, instr(lower(query), 'is:noreply') + 10)
    WHERE instr(lower(query), 'is:noreply') > 0;
  UPDATE splits SET query = substr(query, 1, instr(lower(query), 'is:noreply') - 1) || 'is:unanswered' || substr(query, instr(lower(query), 'is:noreply') + 10)
    WHERE instr(lower(query), 'is:noreply') > 0;
  UPDATE label_rules SET query = substr(query, 1, instr(lower(query), 'is:noreply') - 1) || 'is:unanswered' || substr(query, instr(lower(query), 'is:noreply') + 10)
    WHERE instr(lower(query), 'is:noreply') > 0;
  UPDATE label_rules SET query = substr(query, 1, instr(lower(query), 'is:noreply') - 1) || 'is:unanswered' || substr(query, instr(lower(query), 'is:noreply') + 10)
    WHERE instr(lower(query), 'is:noreply') > 0;
  UPDATE label_rules SET query = substr(query, 1, instr(lower(query), 'is:noreply') - 1) || 'is:unanswered' || substr(query, instr(lower(query), 'is:noreply') + 10)
    WHERE instr(lower(query), 'is:noreply') > 0;
  -- A routine that runs when new mail matches a search keeps that search as JSON text.
  UPDATE cloud_routines SET trigger = substr(trigger, 1, instr(lower(trigger), 'is:noreply') - 1) || 'is:unanswered' || substr(trigger, instr(lower(trigger), 'is:noreply') + 10)
    WHERE instr(lower(trigger), 'is:noreply') > 0;
  UPDATE cloud_routines SET trigger = substr(trigger, 1, instr(lower(trigger), 'is:noreply') - 1) || 'is:unanswered' || substr(trigger, instr(lower(trigger), 'is:noreply') + 10)
    WHERE instr(lower(trigger), 'is:noreply') > 0;
  UPDATE cloud_routines SET trigger = substr(trigger, 1, instr(lower(trigger), 'is:noreply') - 1) || 'is:unanswered' || substr(trigger, instr(lower(trigger), 'is:noreply') + 10)
    WHERE instr(lower(trigger), 'is:noreply') > 0;

  -- The built-in tabs Important and Other give way to Important, Updates, Promotions, Social and Forums (shown only while it holds mail). Custom tabs stay, after them.
  CREATE TEMP TABLE builtin_owners AS SELECT DISTINCT user_id FROM splits WHERE builtin = 1;
  DELETE FROM splits WHERE builtin = 1;
  UPDATE splits SET position = position + 5;
  INSERT INTO splits (id, user_id, name, query, position, builtin, hide_when_empty)
    SELECT 'spl_' || lower(hex(randomblob(9))), o.user_id, d.name, d.query, d.position, 1, d.hide_when_empty
    FROM builtin_owners o CROSS JOIN (
      SELECT 'Important' AS name, 'category:people' AS query, 0 AS position, 0 AS hide_when_empty
      UNION ALL SELECT 'Updates', 'category:updates', 1, 0
      UNION ALL SELECT 'Promotions', 'category:promotions', 2, 0
      UNION ALL SELECT 'Social', 'category:social', 3, 0
      UNION ALL SELECT 'Forums', 'category:forums', 4, 1
    ) d;
  DROP TABLE builtin_owners;
