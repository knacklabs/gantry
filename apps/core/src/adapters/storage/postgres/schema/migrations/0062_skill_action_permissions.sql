ALTER TABLE skill_catalog
  ADD COLUMN IF NOT EXISTS action_permissions_json text NOT NULL DEFAULT '[]';
