CREATE TABLE IF NOT EXISTS agent_tool_sources (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  kind text NOT NULL,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_sources_unique
  ON agent_tool_sources(app_id, agent_id, source_id, kind, version);
