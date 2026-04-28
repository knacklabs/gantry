ALTER TABLE skill_catalog
  ADD COLUMN IF NOT EXISTS agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'bundled',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS storage_type text,
  ADD COLUMN IF NOT EXISTS storage_ref text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS size_bytes integer,
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_skill_id text,
  ADD COLUMN IF NOT EXISTS provider_skill_type text,
  ADD COLUMN IF NOT EXISTS provider_skill_version text;

ALTER TABLE skill_catalog
  ALTER COLUMN status SET DEFAULT 'approved';

UPDATE skill_catalog
  SET status = 'approved'
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_skill_catalog_app_status
  ON skill_catalog(app_id, status);

CREATE INDEX IF NOT EXISTS idx_skill_catalog_app_agent_status
  ON skill_catalog(app_id, agent_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_app_hash
  ON skill_catalog(app_id, content_hash);

DROP INDEX IF EXISTS idx_agent_skill_bindings_unique;

CREATE UNIQUE INDEX idx_agent_skill_bindings_unique
  ON agent_skill_bindings(app_id, agent_id, skill_id);
