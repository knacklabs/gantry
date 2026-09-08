-- Preserve existing text column names while storing the structured principal.
-- A legacy value that already contains a PrincipalRef is left untouched.

-- Direct Person IDs are durable identities even if a person is now offboarded.
UPDATE "permission_decisions" AS decision
SET "approver_ref" = json_build_object(
  'kind', person."kind",
  'personId', person."id"
)::text
FROM "users" AS person
WHERE decision."app_id" = person."app_id"
  AND decision."approver_ref" = person."id"
  AND person."kind" IN ('human', 'service')
  AND decision."approver_ref" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

-- Alias IDs retain their historic identity even after alias retirement.
UPDATE "permission_decisions" AS decision
SET "approver_ref" = jsonb_strip_nulls(jsonb_build_object(
  'kind', person."kind",
  'personId', person."id",
  'aliasId', alias."id"
))::text
FROM "user_aliases" AS alias
JOIN "users" AS person
  ON person."app_id" = alias."app_id"
  AND person."id" = alias."user_id"
WHERE decision."app_id" = alias."app_id"
  AND decision."approver_ref" = alias."id"
  AND person."kind" IN ('human', 'service')
  AND decision."approver_ref" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

-- An Agent configuration identifier resolves through its service Person.
UPDATE "permission_decisions" AS decision
SET "approver_ref" = json_build_object(
  'kind', 'service',
  'personId', person."id"
)::text
FROM "users" AS person
WHERE decision."app_id" = person."app_id"
  AND decision."approver_ref" = person."agent_id"
  AND person."kind" = 'service'
  AND decision."approver_ref" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

-- A conversation approval is authority-bearing. It must resolve through the
-- Person-backed approver set established by the identity migration.
UPDATE "permission_decisions" AS decision
SET "approver_ref" = jsonb_strip_nulls(jsonb_build_object(
  'kind', 'human',
  'personId', approver."person_id",
  'aliasId', approver."alias_id"
))::text
FROM "conversation_approvers" AS approver
WHERE decision."app_id" = approver."app_id"
  AND approver."conversation_id" = decision."actor_context_json"::jsonb ->> 'conversationId'
  AND approver."external_user_id" = decision."approver_ref"
  AND approver."person_id" IS NOT NULL
  AND decision."actor_context_json" LIKE '%"conversationId"%'
  AND decision."approver_ref" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "permission_decisions" AS decision
    WHERE decision."approver_ref" IS NOT NULL
      AND decision."actor_context_json" LIKE '%"conversationId"%'
      AND decision."approver_ref" !~ E'^\\s*\\{\\s*"kind"\\s*:'
      AND decision."approver_ref" NOT IN (
        'runtime',
        'system',
        'permission',
        'reviewed_rule',
        'birthright',
        'deterministic_read_only',
        'auto_classifier',
        'cached_classifier_verdict',
        'trusted_root_grant'
      )
      AND decision."approver_ref" NOT LIKE 'agent:%'
  ) THEN
    RAISE EXCEPTION
      'permission principal migration requires every authority-bearing approver to resolve to a Person or alias';
  END IF;
END $$;
--> statement-breakpoint

UPDATE "permission_decisions"
SET "approver_ref" = json_build_object(
  'kind',
  'system',
  'source',
  "approver_ref"
)::text
WHERE "approver_ref" IS NOT NULL
  AND "approver_ref" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

-- Permission audit events have no conversation authority context. Resolve
-- durable Person, alias, and Agent identifiers; preserve every other source.
UPDATE "permission_audit_events" AS audit
SET "actor_id" = json_build_object(
  'kind', person."kind",
  'personId', person."id"
)::text
FROM "users" AS person
WHERE audit."app_id" = person."app_id"
  AND audit."actor_id" = person."id"
  AND person."kind" IN ('human', 'service')
  AND audit."actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "permission_audit_events" AS audit
SET "actor_id" = jsonb_strip_nulls(jsonb_build_object(
  'kind', person."kind",
  'personId', person."id",
  'aliasId', alias."id"
))::text
FROM "user_aliases" AS alias
JOIN "users" AS person
  ON person."app_id" = alias."app_id"
  AND person."id" = alias."user_id"
WHERE audit."app_id" = alias."app_id"
  AND audit."actor_id" = alias."id"
  AND person."kind" IN ('human', 'service')
  AND audit."actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "permission_audit_events" AS audit
SET "actor_id" = json_build_object(
  'kind', 'service',
  'personId', person."id"
)::text
FROM "users" AS person
WHERE audit."app_id" = person."app_id"
  AND audit."actor_id" = person."agent_id"
  AND person."kind" = 'service'
  AND audit."actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
--> statement-breakpoint

UPDATE "permission_audit_events"
SET "actor_id" = json_build_object(
  'kind', 'system',
  'source', "actor_id"
)::text
WHERE "actor_id" IS NOT NULL
  AND "actor_id" !~ E'^\\s*\\{\\s*"kind"\\s*:';
