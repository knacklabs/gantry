CREATE TABLE IF NOT EXISTS file_artifacts (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  virtual_scope text NOT NULL,
  virtual_path text NOT NULL,
  version integer NOT NULL,
  storage_type text NOT NULL,
  storage_ref text NOT NULL,
  content_hash text NOT NULL,
  size_bytes integer NOT NULL,
  content_type text NOT NULL,
  metadata_json text NOT NULL DEFAULT '{}',
  created_by text,
  promoted_from_artifact_id text REFERENCES file_artifacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_artifacts_version_unique
  ON file_artifacts(app_id, agent_id, virtual_scope, virtual_path, version);

CREATE INDEX IF NOT EXISTS idx_file_artifacts_scope
  ON file_artifacts(app_id, agent_id, virtual_scope, created_at);
