DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "conversation_installs"
    WHERE "id" NOT LIKE 'conversation-route:%'
    GROUP BY "app_id", "agent_id", "conversation_id", COALESCE("thread_id", '')
    HAVING COUNT(DISTINCT "provider_account_id") > 1
       OR COUNT(DISTINCT "workspace_snapshot_id") FILTER (WHERE "workspace_snapshot_id" IS NOT NULL) > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting conversation installs must be resolved before migration: provider account or workspace snapshot differs';
  END IF;
END $$;--> statement-breakpoint

DROP TABLE IF EXISTS "_conversation_install_survivors";--> statement-breakpoint

CREATE TABLE "_conversation_install_survivors" AS
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "app_id", "agent_id", "conversation_id", COALESCE("thread_id", '')
      ORDER BY
        CASE WHEN "status" = 'active' THEN 0 ELSE 1 END,
        CASE WHEN ("memory_subject_json"::jsonb ? 'route') THEN 0 ELSE 1 END,
        "updated_at" DESC,
        "id"
    ) AS "rank"
  FROM "conversation_installs"
  WHERE "id" NOT LIKE 'conversation-route:%'
)
SELECT "id" FROM ranked WHERE "rank" = 1;--> statement-breakpoint

UPDATE "conversation_installs" AS survivor
SET
  "display_name" = merged."display_name",
  "status" = merged."status",
  "sender_policy" = merged."sender_policy",
  "control_policy" = merged."control_policy",
  "memory_scope" = merged."memory_scope",
  "memory_subject_json" = merged."memory_subject_json",
  "workspace_snapshot_id" = COALESCE(merged."workspace_snapshot_id", survivor."workspace_snapshot_id"),
  "created_at" = merged."created_at",
  "updated_at" = merged."updated_at"
FROM (
  SELECT
    keep."id",
    current_row."display_name",
    current_row."status",
    current_row."sender_policy",
    current_row."control_policy",
    current_row."memory_scope",
    memory_row."memory_subject_json",
    current_row."workspace_snapshot_id",
    bounds."created_at",
    bounds."updated_at"
  FROM "_conversation_install_survivors" AS keep
  JOIN "conversation_installs" AS survivor_row ON survivor_row."id" = keep."id"
  JOIN LATERAL (
    SELECT member.*
    FROM "conversation_installs" AS member
    WHERE member."app_id" = survivor_row."app_id"
      AND member."agent_id" = survivor_row."agent_id"
      AND member."conversation_id" = survivor_row."conversation_id"
      AND COALESCE(member."thread_id", '') = COALESCE(survivor_row."thread_id", '')
      AND member."id" NOT LIKE 'conversation-route:%'
    ORDER BY member."updated_at" DESC, member."id"
    LIMIT 1
  ) AS current_row ON TRUE
  JOIN LATERAL (
    SELECT member."memory_subject_json"
    FROM "conversation_installs" AS member
    WHERE member."app_id" = survivor_row."app_id"
      AND member."agent_id" = survivor_row."agent_id"
      AND member."conversation_id" = survivor_row."conversation_id"
      AND COALESCE(member."thread_id", '') = COALESCE(survivor_row."thread_id", '')
      AND member."id" NOT LIKE 'conversation-route:%'
    ORDER BY CASE WHEN member."memory_subject_json"::jsonb ? 'route' THEN 0 ELSE 1 END,
      member."updated_at" DESC, member."id"
    LIMIT 1
  ) AS memory_row ON TRUE
  JOIN LATERAL (
    SELECT MIN(member."created_at") AS "created_at", MAX(member."updated_at") AS "updated_at"
    FROM "conversation_installs" AS member
    WHERE member."app_id" = survivor_row."app_id"
      AND member."agent_id" = survivor_row."agent_id"
      AND member."conversation_id" = survivor_row."conversation_id"
      AND COALESCE(member."thread_id", '') = COALESCE(survivor_row."thread_id", '')
      AND member."id" NOT LIKE 'conversation-route:%'
  ) AS bounds ON TRUE
) AS merged
WHERE survivor."id" = merged."id";--> statement-breakpoint

UPDATE "conversation_installs" AS survivor
SET "permission_policy_ids_json" = merged."permission_policy_ids_json"
FROM (
  SELECT
    keep."id",
    COALESCE(JSONB_AGG(DISTINCT policy."value") FILTER (WHERE policy."value" IS NOT NULL), '[]'::jsonb)::text AS "permission_policy_ids_json"
  FROM "_conversation_install_survivors" AS keep
  JOIN "conversation_installs" AS survivor_row ON survivor_row."id" = keep."id"
  JOIN "conversation_installs" AS member
    ON member."app_id" = survivor_row."app_id"
   AND member."agent_id" = survivor_row."agent_id"
   AND member."conversation_id" = survivor_row."conversation_id"
   AND COALESCE(member."thread_id", '') = COALESCE(survivor_row."thread_id", '')
   AND member."id" NOT LIKE 'conversation-route:%'
  LEFT JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(member."permission_policy_ids_json"::jsonb) AS policy("value") ON TRUE
  GROUP BY keep."id"
) AS merged
WHERE survivor."id" = merged."id";--> statement-breakpoint

DELETE FROM "conversation_installs" AS duplicate
WHERE duplicate."id" NOT LIKE 'conversation-route:%'
  AND NOT EXISTS (
    SELECT 1
    FROM "_conversation_install_survivors" AS keep
    WHERE keep."id" = duplicate."id"
  );--> statement-breakpoint

DROP TABLE "_conversation_install_survivors";--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_conversation_installs_control_scope" ON "conversation_installs" USING btree ("app_id","agent_id","conversation_id",COALESCE("thread_id", '')) WHERE "conversation_installs"."id" NOT LIKE 'conversation-route:%';
