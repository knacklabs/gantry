CREATE TABLE IF NOT EXISTS permission_decision_memory (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  agent_folder text NOT NULL,
  kind text NOT NULL,                 -- classifier_verdict | remembered_deny | trusted_root | standing_grant
  lookup_identity text NOT NULL,
  effect_hash text,
  decision text,                      -- allow | ask (classifier_verdict); deny (remembered_deny)
  reason text NOT NULL,
  canonical_root text,
  principal text,
  effect_schema_version integer NOT NULL,
  rail_version integer NOT NULL,
  provenance text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT permission_decision_memory_lookup_uq UNIQUE (app_id, agent_folder, kind, lookup_identity)
);
CREATE INDEX IF NOT EXISTS permission_decision_memory_active_idx
  ON permission_decision_memory (app_id, agent_folder, kind, lookup_identity) WHERE revoked_at IS NULL;
