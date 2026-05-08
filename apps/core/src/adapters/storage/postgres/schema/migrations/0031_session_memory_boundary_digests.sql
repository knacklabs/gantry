CREATE TABLE IF NOT EXISTS agent_session_digests (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  trigger text NOT NULL,
  digest text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  extracted_fact_count integer NOT NULL DEFAULT 0,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_session_digests_session_created
  ON agent_session_digests(agent_session_id, created_at, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_session_digests_session_trigger
  ON agent_session_digests(agent_session_id, trigger, created_at);
