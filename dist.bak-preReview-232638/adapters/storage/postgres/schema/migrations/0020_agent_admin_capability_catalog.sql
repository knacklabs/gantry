ALTER TABLE tool_catalog
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'host',
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'gantry',
  ADD COLUMN IF NOT EXISTS provider_tool_name text,
  ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS selectable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

UPDATE tool_catalog
SET
  display_name = CASE
    WHEN display_name = '' THEN name
    ELSE display_name
  END,
  kind = CASE
    WHEN name = 'browser' THEN 'browser'
    ELSE kind
  END,
  provider = CASE
    WHEN name = 'browser' THEN 'gantry'
    ELSE provider
  END,
  provider_tool_name = CASE
    WHEN name = 'browser' THEN 'Browser'
    ELSE provider_tool_name
  END,
  category = CASE
    WHEN name = 'browser' THEN 'web'
    ELSE category
  END
WHERE app_id IS NOT NULL;
