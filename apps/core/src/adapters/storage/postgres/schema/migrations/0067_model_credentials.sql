CREATE TABLE IF NOT EXISTS model_credentials (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  schema_version integer NOT NULL,
  payload_encrypted text NOT NULL,
  fingerprint text NOT NULL,
  field_fingerprints_json text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_credentials_app_provider
  ON model_credentials(app_id, provider_id);

CREATE INDEX IF NOT EXISTS idx_model_credentials_app_updated
  ON model_credentials(app_id, updated_at);
