CREATE TABLE IF NOT EXISTS permission_promotion_counters (
  app_id text NOT NULL,
  agent_folder text NOT NULL,
  suggestion_key text NOT NULL,
  allow_count integer NOT NULL DEFAULT 0,
  last_offered_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT permission_promotion_counters_pk
    PRIMARY KEY (app_id, agent_folder, suggestion_key)
);
