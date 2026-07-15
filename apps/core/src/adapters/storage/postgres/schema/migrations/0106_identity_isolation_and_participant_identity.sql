ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider_account_id text NOT NULL DEFAULT '';

UPDATE conversation_participants AS participant
SET
  provider = provider_account.provider_id,
  provider_account_id = conversation.provider_account_id
FROM conversations AS conversation
JOIN provider_accounts AS provider_account
  ON provider_account.id = conversation.provider_account_id
WHERE participant.conversation_id = conversation.id
  AND participant.app_id = conversation.app_id;

DELETE FROM conversation_participants
WHERE external_user_id IS NULL;

ALTER TABLE conversation_participants
  ALTER COLUMN external_user_id SET NOT NULL;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY app_id, conversation_id, provider, provider_account_id, external_user_id
      ORDER BY updated_at DESC, id DESC
    ) AS row_number
  FROM conversation_participants
)
DELETE FROM conversation_participants AS participant
USING ranked
WHERE participant.id = ranked.id
  AND ranked.row_number > 1;

ALTER TABLE users
  ADD CONSTRAINT users_app_id_id_key UNIQUE (app_id, id);

ALTER TABLE user_aliases
  DROP CONSTRAINT IF EXISTS user_aliases_user_id_users_id_fk;

ALTER TABLE user_aliases
  ADD CONSTRAINT user_aliases_app_user_fk
  FOREIGN KEY (app_id, user_id)
  REFERENCES users (app_id, id)
  ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversation_participants_identity
  ON conversation_participants (
    app_id,
    conversation_id,
    provider,
    provider_account_id,
    external_user_id
  );
