ALTER TABLE skill_catalog
  ADD COLUMN IF NOT EXISTS required_env_vars_json text NOT NULL DEFAULT '[]';
