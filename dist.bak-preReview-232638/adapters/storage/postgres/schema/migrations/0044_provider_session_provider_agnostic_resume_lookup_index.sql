CREATE INDEX IF NOT EXISTS idx_provider_sessions_agent_status_updated
  ON provider_sessions(agent_session_id, status, updated_at DESC);
