CREATE INDEX IF NOT EXISTS idx_agent_runs_job_started
  ON agent_runs(job_id, started_at DESC NULLS LAST, created_at DESC);
