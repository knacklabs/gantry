CREATE INDEX IF NOT EXISTS idx_provider_sessions_resume_lookup
  ON provider_sessions(agent_session_id, provider, status, updated_at DESC);
