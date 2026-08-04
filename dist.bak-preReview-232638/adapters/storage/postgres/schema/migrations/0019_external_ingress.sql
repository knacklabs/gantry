CREATE TABLE IF NOT EXISTS external_ingresses (
  ingress_id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_ingresses_app_id_name_key UNIQUE (app_id, name)
);

CREATE INDEX IF NOT EXISTS idx_external_ingresses_app_enabled
  ON external_ingresses(app_id, enabled);

CREATE TABLE IF NOT EXISTS external_ingress_invocations (
  invocation_id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  ingress_id text NOT NULL REFERENCES external_ingresses(ingress_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  nonce text NOT NULL,
  request_method text NOT NULL,
  request_path text NOT NULL,
  request_timestamp timestamptz NOT NULL,
  body_hash text NOT NULL,
  request_body text NOT NULL,
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  response_json text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT external_ingress_invocations_app_id_ingress_id_idempotency_key_key
    UNIQUE (app_id, ingress_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_external_ingress_invocations_app_created
  ON external_ingress_invocations(app_id, created_at);

CREATE INDEX IF NOT EXISTS idx_external_ingress_invocations_ingress_status_created
  ON external_ingress_invocations(ingress_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_external_ingress_invocations_expires
  ON external_ingress_invocations(expires_at);

CREATE TABLE IF NOT EXISTS external_ingress_nonces (
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  ingress_id text NOT NULL REFERENCES external_ingresses(ingress_id) ON DELETE CASCADE,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT external_ingress_nonces_pk PRIMARY KEY (app_id, ingress_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_external_ingress_nonces_expiry
  ON external_ingress_nonces(app_id, ingress_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_external_ingress_nonces_expires
  ON external_ingress_nonces(expires_at);
