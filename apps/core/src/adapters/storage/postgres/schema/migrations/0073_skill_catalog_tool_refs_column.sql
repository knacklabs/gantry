ALTER TABLE skill_catalog
  ADD COLUMN IF NOT EXISTS tool_refs_json text NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'skill_catalog'
      AND column_name = 'tool_ids_json'
      AND table_schema = current_schema()
  ) THEN
    EXECUTE
      'UPDATE skill_catalog
       SET tool_refs_json = tool_ids_json
       WHERE tool_refs_json = ''[]''';
  END IF;
END $$;

ALTER TABLE skill_catalog
  DROP COLUMN IF EXISTS tool_ids_json;
