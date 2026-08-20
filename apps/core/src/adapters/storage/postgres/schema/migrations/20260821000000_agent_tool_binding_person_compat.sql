ALTER TABLE "agent_tool_bindings"
  ADD COLUMN IF NOT EXISTS "person_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_tool_bindings_app_person_fk'
      AND conrelid = 'agent_tool_bindings'::regclass
  ) THEN
    ALTER TABLE "agent_tool_bindings"
      ADD CONSTRAINT "agent_tool_bindings_app_person_fk"
      FOREIGN KEY ("app_id", "person_id")
      REFERENCES "users"("app_id", "id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'idx_agent_tool_bindings_unique'
      AND conrelid = 'agent_tool_bindings'::regclass
  ) THEN
    DROP INDEX IF EXISTS "idx_agent_tool_bindings_unique";
    ALTER TABLE "agent_tool_bindings"
      ADD CONSTRAINT "idx_agent_tool_bindings_unique"
      UNIQUE NULLS NOT DISTINCT (
        "agent_id",
        "tool_id",
        "config_version_id",
        "person_id"
      );
  END IF;
END $$;
