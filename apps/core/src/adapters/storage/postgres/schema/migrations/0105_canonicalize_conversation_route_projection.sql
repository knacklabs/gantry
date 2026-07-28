-- Repair route-projection rows that still point at pre-provider-account
-- conversation ids. Runtime route loading can tolerate and warn on these rows,
-- but thread/event persistence needs the canonical parent conversation id.
WITH simple_route_rows AS (
  SELECT
    b."id",
    b."app_id",
    b."provider_account_id",
    b."conversation_id" AS "legacy_conversation_id",
    substring(b."id" from char_length('conversation-route:') + 1) AS "route_jid"
  FROM "conversation_installs" b
  WHERE b."id" LIKE 'conversation-route:%'
    AND b."thread_id" IS NULL
    AND b."provider_account_id" IS NOT NULL
),
canonical_route_rows AS (
  SELECT
    r.*,
    ('conversation:' || r."provider_account_id" || ':' || r."route_jid") AS "canonical_conversation_id"
  FROM simple_route_rows r
  WHERE r."legacy_conversation_id" = 'conversation:' || r."route_jid"
    AND (
      r."route_jid" LIKE 'sl:%'
      OR r."route_jid" LIKE 'tg:%'
      OR r."route_jid" LIKE 'dc:%'
      OR r."route_jid" LIKE 'app:%'
      OR r."route_jid" LIKE 'teams:%'
    )
),
inserted_conversations AS (
  INSERT INTO "conversations" (
    "id",
    "app_id",
    "provider_account_id",
    "external_ref_json",
    "kind",
    "title",
    "status",
    "created_at",
    "updated_at"
  )
  SELECT
    r."canonical_conversation_id",
    c."app_id",
    r."provider_account_id",
    c."external_ref_json",
    c."kind",
    c."title",
    c."status",
    c."created_at",
    now()
  FROM canonical_route_rows r
  JOIN "conversations" c
    ON c."id" = r."legacy_conversation_id"
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
),
available_canonical_rows AS (
  SELECT r.*
  FROM canonical_route_rows r
  WHERE EXISTS (
    SELECT 1
    FROM "conversations" c
    WHERE c."id" = r."canonical_conversation_id"
  )
  OR EXISTS (
    SELECT 1
    FROM inserted_conversations c
    WHERE c."id" = r."canonical_conversation_id"
  )
)
UPDATE "conversation_installs" b
SET
  "conversation_id" = r."canonical_conversation_id",
  "memory_subject_json" = jsonb_set(
    jsonb_set(
      b."memory_subject_json"::jsonb,
      '{conversationId}',
      to_jsonb(r."canonical_conversation_id"),
      true
    ),
    '{route,conversationId}',
    to_jsonb(r."canonical_conversation_id"),
    true
  )::text,
  "updated_at" = now()
FROM available_canonical_rows r
WHERE b."id" = r."id"
  AND b."conversation_id" = r."legacy_conversation_id";
