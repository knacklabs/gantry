CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation_created
  ON agent_runs (app_id, conversation_id, created_at DESC, id DESC);
