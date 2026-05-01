CREATE TABLE IF NOT EXISTS agent_dm_approvers (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_dm_approvers_agent
  ON agent_dm_approvers(app_id, agent_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_dm_approver_provider
  ON agent_dm_approvers(app_id, agent_id, provider_id);
