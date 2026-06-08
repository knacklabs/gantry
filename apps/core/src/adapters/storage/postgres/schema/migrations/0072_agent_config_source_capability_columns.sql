ALTER TABLE agent_config_versions
  ADD COLUMN IF NOT EXISTS capability_refs_json text NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS source_refs_json text NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'agent_config_versions'
      AND column_name = 'tool_ids_json'
      AND table_schema = current_schema()
  ) THEN
    EXECUTE
      'UPDATE agent_config_versions
       SET capability_refs_json = tool_ids_json
       WHERE capability_refs_json = ''[]''';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'agent_config_versions'
      AND column_name = 'skill_ids_json'
      AND table_schema = current_schema()
  ) THEN
    EXECUTE
      'UPDATE agent_config_versions
       SET source_refs_json = skill_ids_json
       WHERE source_refs_json = ''[]''';
  END IF;
END $$;

ALTER TABLE agent_config_versions
  DROP COLUMN IF EXISTS tool_ids_json,
  DROP COLUMN IF EXISTS skill_ids_json;
