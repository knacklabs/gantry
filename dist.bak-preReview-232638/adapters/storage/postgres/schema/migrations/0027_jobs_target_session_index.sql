CREATE INDEX IF NOT EXISTS idx_jobs_target_session_updated
  ON jobs ((target_json::jsonb ->> 'sessionId'), updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_started_created
  ON agent_runs(started_at DESC NULLS LAST, created_at DESC);
