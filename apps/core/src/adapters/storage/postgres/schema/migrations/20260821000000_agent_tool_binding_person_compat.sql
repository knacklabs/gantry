ALTER TABLE "agent_tool_bindings"
  ADD COLUMN IF NOT EXISTS "person_id" text;

-- Legacy deployments used a regular unique index over nullable binding keys.
-- PostgreSQL treats nulls as distinct in that index, so repeated settings
-- reconciliation could leave multiple rows for the same effective grant.
-- Keep the newest active row before replacing that index with the stricter
-- NULLS NOT DISTINCT constraint below.
WITH ranked_agent_tool_bindings AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY
        "agent_id",
        "tool_id",
        "config_version_id",
        "person_id"
      ORDER BY
        CASE WHEN "status" = 'active' THEN 0 ELSE 1 END,
        "updated_at" DESC,
        "created_at" DESC,
        "id" DESC
    ) AS binding_rank
  FROM "agent_tool_bindings"
)
DELETE FROM "agent_tool_bindings"
WHERE "id" IN (
  SELECT "id"
  FROM ranked_agent_tool_bindings
  WHERE binding_rank > 1
);

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
