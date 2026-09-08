-- Preserve the existing column name while upgrading the audit actor value.
-- Person merge actors are provenance, not an authorization callback: legacy
-- values that cannot be bound to a Person remain observable system sources.

UPDATE "person_merge_audit" AS audit
SET "actor" = json_build_object(
  'kind', person."kind",
  'personId', person."id"
)::text
FROM "users" AS person
WHERE audit."app_id" = person."app_id"
  AND audit."actor" = person."id"
  AND person."kind" IN ('human', 'service')
  AND audit."actor" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "person_merge_audit" AS audit
SET "actor" = jsonb_strip_nulls(jsonb_build_object(
  'kind', person."kind",
  'personId', person."id",
  'aliasId', alias."id"
))::text
FROM "user_aliases" AS alias
JOIN "users" AS person
  ON person."app_id" = alias."app_id"
  AND person."id" = alias."user_id"
WHERE audit."app_id" = alias."app_id"
  AND audit."actor" = alias."id"
  AND person."kind" IN ('human', 'service')
  AND audit."actor" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "person_merge_audit" AS audit
SET "actor" = json_build_object(
  'kind', 'service',
  'personId', person."id"
)::text
FROM "users" AS person
WHERE audit."app_id" = person."app_id"
  AND audit."actor" = person."agent_id"
  AND person."kind" = 'service'
  AND audit."actor" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "person_merge_audit"
SET "actor" = json_build_object(
  'kind', 'system', 'source', "actor"
)::text
WHERE "actor" !~ E'^\\s*\\{\\s*"kind"\\s*:';
