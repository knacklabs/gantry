CREATE TABLE IF NOT EXISTS agent_permission_rules (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  effect text NOT NULL,
  rule text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_permission_rules_agent
  ON agent_permission_rules (app_id, agent_id, effect);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_permission_rule
  ON agent_permission_rules (app_id, agent_id, effect, rule);
