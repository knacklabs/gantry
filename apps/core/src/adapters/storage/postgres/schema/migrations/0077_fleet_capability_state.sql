CREATE TABLE IF NOT EXISTS runtime_dependencies (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  -- Manifest hash is the bake idempotency key: one bake per (app_id, hash).
  manifest_hash text NOT NULL,
  -- npm-only package specs requested for the fleet toolchain.
  requested_packages_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- status lifecycle: queued | baking | uploaded | activated | failed.
  status text NOT NULL DEFAULT 'queued',
  storage_type text,
  storage_ref text,
  content_hash text,
  size_bytes integer,
  failure_reason text,
  requested_by_agent_id text,
  approved_by_conversation_id text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_dependencies_app_manifest ON runtime_dependencies(app_id, manifest_hash);
CREATE INDEX IF NOT EXISTS idx_runtime_dependencies_app_status ON runtime_dependencies(app_id, status, updated_at);

CREATE TABLE IF NOT EXISTS settings_revisions (
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  -- Monotonic per app_id; allocated transactionally on append.
  revision integer NOT NULL,
  settings_document_json jsonb NOT NULL,
  -- A worker older than this version holds its last-applied revision and alerts.
  min_reader_version integer NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  note text,
  created_at timestamptz NOT NULL,
  CONSTRAINT settings_revisions_pk PRIMARY KEY (app_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_settings_revisions_app_created ON settings_revisions(app_id, created_at);
