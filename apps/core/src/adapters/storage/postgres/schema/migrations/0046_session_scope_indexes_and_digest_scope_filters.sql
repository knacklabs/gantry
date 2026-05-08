ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS scope_key text;

CREATE INDEX IF NOT EXISTS idx_agent_sessions_app_scope_key
  ON agent_sessions(app_id, scope_key);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_app_scope_key_prefix
  ON agent_sessions(app_id, scope_key text_pattern_ops);

ALTER TABLE agent_session_digests
  ADD COLUMN IF NOT EXISTS scope_app_id text,
  ADD COLUMN IF NOT EXISTS scope_agent_id text,
  ADD COLUMN IF NOT EXISTS scope_conversation_id text,
  ADD COLUMN IF NOT EXISTS scope_user_id text,
  ADD COLUMN IF NOT EXISTS scope_thread_id text;

CREATE INDEX IF NOT EXISTS idx_agent_session_digests_scope_created
  ON agent_session_digests(
    agent_session_id,
    scope_app_id,
    scope_agent_id,
    scope_conversation_id,
    scope_user_id,
    scope_thread_id,
    created_at DESC,
    id DESC
  );
