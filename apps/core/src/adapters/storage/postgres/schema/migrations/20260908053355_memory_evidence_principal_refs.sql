-- `memory_evidence.actor_id` and `memory_items.source_ref_json.demoted_by`
-- are durable provenance. They retain their column/key names but store a
-- structured principal rather than an unqualified literal.

UPDATE "memory_evidence" AS evidence
SET "actor_id" = json_build_object(
  'kind', person."kind",
  'personId', person."id"
)::text
FROM "users" AS person
WHERE evidence."app_id" = person."app_id"
  AND evidence."actor_id" = person."id"
  AND person."kind" IN ('human', 'service')
  AND evidence."actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "memory_evidence" AS evidence
SET "actor_id" = jsonb_strip_nulls(jsonb_build_object(
  'kind', person."kind",
  'personId', person."id",
  'aliasId', alias."id"
))::text
FROM "user_aliases" AS alias
JOIN "users" AS person
  ON person."app_id" = alias."app_id"
  AND person."id" = alias."user_id"
WHERE evidence."app_id" = alias."app_id"
  AND evidence."actor_id" = alias."id"
  AND person."kind" IN ('human', 'service')
  AND evidence."actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "memory_evidence" AS evidence
SET "actor_id" = json_build_object(
  'kind', 'service',
  'personId', person."id"
)::text
FROM "users" AS person
WHERE evidence."app_id" = person."app_id"
  AND evidence."actor_id" = person."agent_id"
  AND person."kind" = 'service'
  AND evidence."actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "memory_evidence"
SET "actor_id" = json_build_object(
  'kind', 'system', 'source', "actor_id"
)::text
WHERE "actor_id" IS NOT NULL
  AND "actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "memory_items" AS item
SET "source_ref_json" = jsonb_set(
  item."source_ref_json",
  '{demoted_by}',
  jsonb_build_object('kind', person."kind", 'personId', person."id")
)
FROM "users" AS person
WHERE item."app_id" = person."app_id"
  AND item."source_ref_json" ->> 'demoted_by' = person."id"
  AND person."kind" IN ('human', 'service')
  AND jsonb_typeof(item."source_ref_json" -> 'demoted_by') = 'string';
--> statement-breakpoint

UPDATE "memory_items" AS item
SET "source_ref_json" = jsonb_set(
  item."source_ref_json",
  '{demoted_by}',
  jsonb_strip_nulls(jsonb_build_object(
    'kind', person."kind", 'personId', person."id", 'aliasId', alias."id"
  ))
)
FROM "user_aliases" AS alias
JOIN "users" AS person
  ON person."app_id" = alias."app_id"
  AND person."id" = alias."user_id"
WHERE item."app_id" = alias."app_id"
  AND item."source_ref_json" ->> 'demoted_by' = alias."id"
  AND person."kind" IN ('human', 'service')
  AND jsonb_typeof(item."source_ref_json" -> 'demoted_by') = 'string';
--> statement-breakpoint

UPDATE "memory_items" AS item
SET "source_ref_json" = jsonb_set(
  item."source_ref_json",
  '{demoted_by}',
  jsonb_build_object('kind', 'service', 'personId', person."id")
)
FROM "users" AS person
WHERE item."app_id" = person."app_id"
  AND item."source_ref_json" ->> 'demoted_by' = person."agent_id"
  AND person."kind" = 'service'
  AND jsonb_typeof(item."source_ref_json" -> 'demoted_by') = 'string';
--> statement-breakpoint

UPDATE "memory_items" AS item
SET "source_ref_json" = jsonb_set(
  item."source_ref_json",
  '{demoted_by}',
  jsonb_build_object('kind', 'system', 'source', item."source_ref_json" ->> 'demoted_by')
)
WHERE jsonb_typeof(item."source_ref_json" -> 'demoted_by') = 'string';
