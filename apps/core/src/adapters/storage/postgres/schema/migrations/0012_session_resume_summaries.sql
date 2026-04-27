-- Durable canonical session resume support.

ALTER TABLE provider_sessions
  ALTER COLUMN artifact_ref DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS metadata_json text NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS agent_session_summaries (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  summary text NOT NULL,
  source text NOT NULL DEFAULT 'extractive',
  from_message_id text,
  to_message_id text,
  from_run_id text,
  to_run_id text,
  message_count integer NOT NULL DEFAULT 0,
  run_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_session_summaries_session_created
  ON agent_session_summaries(agent_session_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created
  ON agent_runs(session_id, created_at, id);
