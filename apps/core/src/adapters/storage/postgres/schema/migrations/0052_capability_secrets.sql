CREATE TABLE IF NOT EXISTS capability_secrets (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  value_encrypted text NOT NULL,
  allowed_capability_ids_json text NOT NULL DEFAULT '[]',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_secrets_app_name
  ON capability_secrets(app_id, name);

CREATE INDEX IF NOT EXISTS idx_capability_secrets_app_updated
  ON capability_secrets(app_id, updated_at);
