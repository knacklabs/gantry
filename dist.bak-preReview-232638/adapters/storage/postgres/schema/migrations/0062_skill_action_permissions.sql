ALTER TABLE skill_catalog
  ADD COLUMN IF NOT EXISTS action_permissions_json jsonb;

ALTER TABLE skill_catalog
  ALTER COLUMN action_permissions_json TYPE jsonb
  USING action_permissions_json::jsonb;

ALTER TABLE skill_catalog
  ALTER COLUMN action_permissions_json SET DEFAULT '[]'::jsonb;

UPDATE skill_catalog
SET action_permissions_json = '[]'::jsonb
WHERE action_permissions_json IS NULL;

ALTER TABLE skill_catalog
  ALTER COLUMN action_permissions_json SET NOT NULL;
