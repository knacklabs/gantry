-- Repository contract support for canonical Postgres adapters.

ALTER TABLE permission_decisions
  ADD COLUMN IF NOT EXISTS actor_context_json text,
  ADD COLUMN IF NOT EXISTS action_preview text;

DROP INDEX IF EXISTS idx_messages_external_redelivery_unique;
CREATE UNIQUE INDEX idx_messages_external_redelivery_unique
  ON messages(
    channel_provider,
    channel_installation_id,
    conversation_id,
    COALESCE(thread_id, ''),
    external_message_id
  )
  WHERE external_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_deterministic_key
  ON agent_sessions(
    app_id,
    agent_id,
    COALESCE(conversation_id, ''),
    COALESCE(thread_id, ''),
    COALESCE(user_id, '')
  )
  WHERE job_id IS NULL;
