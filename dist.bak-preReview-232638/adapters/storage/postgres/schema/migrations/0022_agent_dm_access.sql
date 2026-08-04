CREATE TABLE IF NOT EXISTS agent_dm_access (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_dm_access_agent
  ON agent_dm_access(app_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_dm_access_lookup
  ON agent_dm_access(app_id, provider_id, external_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_dm_access_user
  ON agent_dm_access(app_id, agent_id, provider_id, external_user_id);
