DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "provider_connections" pc
    WHERE NOT EXISTS (
      SELECT 1 FROM "agent_conversation_bindings" acb
      WHERE acb."app_id" = pc."app_id"
        AND acb."provider_connection_id" = pc."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "agents" a
      WHERE a."app_id" = pc."app_id"
    )
  ) THEN
    RAISE EXCEPTION 'Cannot migrate provider_connections without an agent in the same app';
  END IF;
END $$;

DO $$
DECLARE
  revision_record record;
  doc jsonb;
  default_agent_id text;
  providers_doc jsonb;
  provider_accounts_doc jsonb;
  agents_doc jsonb;
  conversations_doc jsonb;
  provider_entry record;
  account_entry record;
  agent_entry record;
  agent_binding_entry record;
  conversation_entry record;
  binding_entry record;
  provider_account_id text;
  binding_agent_id text;
  binding_jid text;
  binding_external_id text;
  install_provider_account_id text;
  source_provider_account_id text;
  installed_agents_doc jsonb;
BEGIN
  FOR revision_record IN
    SELECT "app_id", "revision", "settings_document_json"
    FROM "settings_revisions"
    WHERE "settings_document_json" ? 'provider_connections'
      OR "settings_document_json" ? 'bindings'
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(COALESCE("settings_document_json" -> 'providers', '{}'::jsonb)) p
        WHERE p.value ? 'default_connection'
          OR p.value ? 'defaultConnection'
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(COALESCE("settings_document_json" -> 'agents', '{}'::jsonb)) a
        WHERE a.value ? 'bindings'
      )
  LOOP
    doc := revision_record."settings_document_json";
    default_agent_id := (
      SELECT key
      FROM jsonb_each(COALESCE(doc -> 'agents', '{}'::jsonb))
      LIMIT 1
    );

    providers_doc := '{}'::jsonb;
    FOR provider_entry IN
      SELECT key, value
      FROM jsonb_each(COALESCE(doc -> 'providers', '{}'::jsonb))
    LOOP
      providers_doc := jsonb_set(
        providers_doc,
        ARRAY[provider_entry.key],
        provider_entry.value - 'default_connection' - 'defaultConnection',
        true
      );
    END LOOP;

    provider_accounts_doc := COALESCE(doc -> 'provider_accounts', '{}'::jsonb);
    FOR account_entry IN
      SELECT key, value
      FROM jsonb_each(COALESCE(doc -> 'provider_connections', '{}'::jsonb))
    LOOP
      provider_accounts_doc := jsonb_set(
        provider_accounts_doc,
        ARRAY[account_entry.key],
        jsonb_strip_nulls(
          (account_entry.value - 'external_ref' - 'default_agent' - 'defaultAgent')
          || jsonb_build_object(
            'agent',
            COALESCE(
              (
                SELECT b.value ->> 'agent'
                FROM jsonb_each(COALESCE(doc -> 'bindings', '{}'::jsonb)) b
                JOIN jsonb_each(COALESCE(doc -> 'conversations', '{}'::jsonb)) c
                  ON c.key = b.value ->> 'conversation'
                WHERE c.value ->> 'provider_connection' = account_entry.key
                  AND b.value ? 'agent'
                LIMIT 1
              ),
              account_entry.value ->> 'agent',
              account_entry.value ->> 'agent_id',
              default_agent_id
            ),
            'external_identity_ref',
            account_entry.value -> 'external_ref'
          )
        ),
        true
      );
    END LOOP;

    agents_doc := '{}'::jsonb;
    FOR agent_entry IN
      SELECT key, value
      FROM jsonb_each(COALESCE(doc -> 'agents', '{}'::jsonb))
    LOOP
      agents_doc := jsonb_set(
        agents_doc,
        ARRAY[agent_entry.key],
        agent_entry.value - 'bindings',
        true
      );
    END LOOP;

    conversations_doc := COALESCE(doc -> 'conversations', '{}'::jsonb);
    FOR conversation_entry IN
      SELECT key, value
      FROM jsonb_each(COALESCE(doc -> 'conversations', '{}'::jsonb))
    LOOP
      provider_account_id := COALESCE(
        conversation_entry.value ->> 'provider_account',
        conversation_entry.value ->> 'provider_connection'
      );
      installed_agents_doc := COALESCE(
        conversation_entry.value -> 'installed_agents',
        '{}'::jsonb
      );

      FOR binding_entry IN
        SELECT key, value
        FROM jsonb_each(COALESCE(doc -> 'bindings', '{}'::jsonb))
      LOOP
        IF binding_entry.value ->> 'conversation' = conversation_entry.key THEN
          binding_agent_id := binding_entry.value ->> 'agent';
          install_provider_account_id := provider_account_id;
          IF provider_account_id IS NOT NULL
            AND binding_agent_id IS NOT NULL
            AND provider_accounts_doc ? provider_account_id
            AND COALESCE(provider_accounts_doc -> provider_account_id ->> 'agent', '') <> binding_agent_id
          THEN
            install_provider_account_id := provider_account_id || ':agent:' || binding_agent_id;
            provider_accounts_doc := jsonb_set(
              provider_accounts_doc,
              ARRAY[install_provider_account_id],
              jsonb_strip_nulls(
                ((provider_accounts_doc -> provider_account_id) - 'external_identity_ref')
                || jsonb_build_object('agent', binding_agent_id)
              ),
              true
            );
          END IF;
          installed_agents_doc := jsonb_set(
            installed_agents_doc,
            ARRAY[binding_entry.key],
            jsonb_strip_nulls(
              jsonb_build_object(
                'agent',
                binding_agent_id,
                'provider_account',
                install_provider_account_id,
                'status',
                'active',
                'added_at',
                binding_entry.value ->> 'added_at',
                'memory_scope',
                binding_entry.value ->> 'memory_scope',
                'trigger',
                binding_entry.value ->> 'trigger',
                'requires_trigger',
                binding_entry.value -> 'requires_trigger',
                'model',
                binding_entry.value ->> 'model'
              )
            ),
            true
          );
        END IF;
      END LOOP;

      FOR agent_entry IN
        SELECT key, value
        FROM jsonb_each(COALESCE(doc -> 'agents', '{}'::jsonb))
      LOOP
        FOR agent_binding_entry IN
          SELECT key, value
          FROM jsonb_each(COALESCE(agent_entry.value -> 'bindings', '{}'::jsonb))
        LOOP
          binding_jid := agent_binding_entry.value ->> 'jid';
          binding_external_id := CASE
            WHEN binding_jid LIKE '%:%' THEN substring(binding_jid from position(':' in binding_jid) + 1)
            ELSE binding_jid
          END;
          install_provider_account_id := COALESCE(
            agent_binding_entry.value ->> 'provider_account_id',
            agent_binding_entry.value ->> 'providerAccountId',
            agent_binding_entry.value ->> 'provider_account',
            agent_binding_entry.value ->> 'provider_connection_id',
            agent_binding_entry.value ->> 'providerConnectionId',
            provider_account_id
          );
          IF binding_jid IS NOT NULL
            AND (
              agent_binding_entry.value ->> 'conversation' = conversation_entry.key
              OR conversation_entry.value ->> 'external_id' IN (binding_jid, binding_external_id)
              OR conversation_entry.value ->> 'id' IN (binding_jid, binding_external_id)
            )
          THEN
            binding_agent_id := agent_entry.key;
            install_provider_account_id := COALESCE(install_provider_account_id, provider_account_id);
            source_provider_account_id := install_provider_account_id;
            IF install_provider_account_id IS NOT NULL
              AND binding_agent_id IS NOT NULL
              AND provider_accounts_doc ? install_provider_account_id
              AND COALESCE(provider_accounts_doc -> install_provider_account_id ->> 'agent', '') <> binding_agent_id
            THEN
              install_provider_account_id := install_provider_account_id || ':agent:' || binding_agent_id;
              provider_accounts_doc := jsonb_set(
                provider_accounts_doc,
                ARRAY[install_provider_account_id],
                jsonb_strip_nulls(
                  ((provider_accounts_doc -> source_provider_account_id) - 'external_identity_ref')
                  || jsonb_build_object('agent', binding_agent_id)
                ),
                true
              );
            END IF;
            installed_agents_doc := jsonb_set(
              installed_agents_doc,
              ARRAY[agent_binding_entry.key],
              jsonb_strip_nulls(
                jsonb_build_object(
                  'agent',
                  binding_agent_id,
                  'provider_account',
                  install_provider_account_id,
                  'status',
                  'active',
                  'thread_id',
                  COALESCE(agent_binding_entry.value ->> 'thread_id', agent_binding_entry.value ->> 'threadId'),
                  'added_at',
                  COALESCE(agent_binding_entry.value ->> 'added_at', agent_binding_entry.value ->> 'addedAt'),
                  'memory_scope',
                  COALESCE(agent_binding_entry.value ->> 'memory_scope', agent_binding_entry.value ->> 'memoryScope'),
                  'trigger',
                  agent_binding_entry.value ->> 'trigger',
                  'requires_trigger',
                  COALESCE(agent_binding_entry.value -> 'requires_trigger', agent_binding_entry.value -> 'requiresTrigger'),
                  'model',
                  agent_binding_entry.value ->> 'model'
                )
              ),
              true
            );
          END IF;
        END LOOP;
      END LOOP;

      conversations_doc := jsonb_set(
        conversations_doc,
        ARRAY[conversation_entry.key],
        jsonb_strip_nulls(
          (conversation_entry.value - 'provider_connection')
          || jsonb_build_object(
            'provider_account',
            provider_account_id,
            'installed_agents',
            installed_agents_doc
          )
        ),
        true
      );
    END LOOP;

    UPDATE "settings_revisions"
    SET "settings_document_json" =
      (doc - 'provider_connections' - 'bindings')
      || jsonb_build_object(
        'providers',
        providers_doc,
        'provider_accounts',
        provider_accounts_doc,
        'agents',
        agents_doc,
        'conversations',
        conversations_doc
      )
    WHERE "app_id" = revision_record."app_id"
      AND "revision" = revision_record."revision";
  END LOOP;
END $$;

ALTER TABLE "provider_connections"
  RENAME TO "provider_accounts";

ALTER TABLE "provider_accounts"
  RENAME COLUMN "external_ref_json" TO "external_identity_ref_json";

ALTER TABLE "provider_accounts"
  ADD COLUMN "agent_id" text;

UPDATE "provider_accounts" pa
SET "agent_id" = coalesce(
  (
    SELECT acb."agent_id"
    FROM "agent_conversation_bindings" acb
    WHERE acb."app_id" = pa."app_id"
      AND acb."provider_connection_id" = pa."id"
    ORDER BY acb."created_at", acb."id"
    LIMIT 1
  ),
  (
    SELECT a."id"
    FROM "agents" a
    WHERE a."app_id" = pa."app_id"
    ORDER BY a."created_at", a."id"
    LIMIT 1
  )
);

INSERT INTO "provider_accounts" (
  "id",
  "app_id",
  "agent_id",
  "provider_id",
  "external_identity_ref_json",
  "label",
  "status",
  "config_json",
  "runtime_secret_refs_json",
  "created_at",
  "updated_at"
)
SELECT
  pa."id" || ':agent:' || regexp_replace(acb."agent_id", '^agent:', ''),
  pa."app_id",
  acb."agent_id",
  pa."provider_id",
  NULL,
  pa."label",
  pa."status",
  pa."config_json",
  pa."runtime_secret_refs_json",
  pa."created_at",
  pa."updated_at"
FROM "provider_accounts" pa
JOIN (
  SELECT DISTINCT "app_id", "provider_connection_id", "agent_id"
  FROM "agent_conversation_bindings"
) acb ON acb."app_id" = pa."app_id"
  AND acb."provider_connection_id" = pa."id"
WHERE acb."agent_id" <> pa."agent_id"
ON CONFLICT ("id") DO NOTHING;

UPDATE "agent_conversation_bindings" acb
SET "provider_connection_id" = pa."id" || ':agent:' || regexp_replace(acb."agent_id", '^agent:', '')
FROM "provider_accounts" pa
WHERE acb."app_id" = pa."app_id"
  AND acb."provider_connection_id" = pa."id"
  AND acb."agent_id" <> pa."agent_id";

ALTER TABLE "provider_accounts"
  ALTER COLUMN "agent_id" SET NOT NULL,
  ADD CONSTRAINT "provider_accounts_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade;

ALTER INDEX IF EXISTS "provider_connections_pkey"
  RENAME TO "provider_accounts_pkey";

ALTER INDEX IF EXISTS "idx_provider_connections_provider"
  RENAME TO "idx_provider_accounts_provider";

CREATE INDEX "idx_provider_accounts_agent"
  ON "provider_accounts"("app_id", "agent_id");

CREATE UNIQUE INDEX "uniq_provider_accounts_active_identity"
  ON "provider_accounts"("app_id", "provider_id", "external_identity_ref_json")
  WHERE "status" = 'active' AND "external_identity_ref_json" IS NOT NULL;

ALTER TABLE "agent_conversation_bindings"
  RENAME TO "conversation_installs";

ALTER TABLE "conversation_installs"
  RENAME COLUMN "provider_connection_id" TO "provider_account_id";

ALTER TABLE "conversation_installs"
  ADD COLUMN "sender_policy" text DEFAULT 'provider_native' NOT NULL,
  ADD COLUMN "control_policy" text DEFAULT 'conversation_approvers' NOT NULL;

WITH binding_trigger_routes AS (
  SELECT
    "id",
    COALESCE(NULLIF("memory_subject_json", ''), '{}')::jsonb AS "memory_subject",
    "trigger_pattern",
    "requires_trigger",
    "trigger_mode"
  FROM "conversation_installs"
)
UPDATE "conversation_installs" ci
SET "memory_subject_json" = (
  binding_trigger_routes."memory_subject" ||
  jsonb_build_object(
    'route',
    (
      CASE
        WHEN jsonb_typeof(binding_trigger_routes."memory_subject" -> 'route') = 'object'
          THEN binding_trigger_routes."memory_subject" -> 'route'
        ELSE '{}'::jsonb
      END
    ) ||
    jsonb_build_object(
      'trigger', binding_trigger_routes."trigger_pattern",
      'requiresTrigger', binding_trigger_routes."requires_trigger",
      'triggerMode', binding_trigger_routes."trigger_mode"
    )
  )
)::text
FROM binding_trigger_routes
WHERE ci."id" = binding_trigger_routes."id";

ALTER TABLE "conversation_installs"
  DROP COLUMN IF EXISTS "trigger_pattern",
  DROP COLUMN IF EXISTS "requires_trigger",
  DROP COLUMN IF EXISTS "is_admin_binding",
  DROP COLUMN IF EXISTS "trigger_mode";

ALTER INDEX IF EXISTS "agent_conversation_bindings_pkey"
  RENAME TO "conversation_installs_pkey";

ALTER INDEX IF EXISTS "idx_agent_conversation_bindings_conversation"
  RENAME TO "idx_conversation_installs_conversation";

ALTER INDEX IF EXISTS "idx_agent_conversation_bindings_agent_conversation"
  RENAME TO "idx_conversation_installs_agent_conversation";

CREATE INDEX "idx_conversation_installs_account"
  ON "conversation_installs"("provider_account_id");

ALTER TABLE "conversations"
  RENAME COLUMN "provider_connection_id" TO "provider_account_id";

CREATE TEMP TABLE "__conversation_account_clones" ON COMMIT DROP AS
WITH conversation_account_targets AS (
  SELECT
    c."id" AS "old_conversation_id",
    c."provider_account_id" AS "target_provider_account_id"
  FROM "conversations" c
  UNION
  SELECT
    c."id" AS "old_conversation_id",
    ci."provider_account_id" AS "target_provider_account_id"
  FROM "conversation_installs" ci
  JOIN "conversations" c ON c."id" = ci."conversation_id"
),
conversation_account_rekeys AS (
  SELECT DISTINCT
    targets."old_conversation_id",
    CASE
      WHEN c."id" LIKE 'conversation:' || c."provider_account_id" || ':%'
        THEN 'conversation:' || targets."target_provider_account_id" || ':' || substring(c."id" from char_length('conversation:' || c."provider_account_id" || ':') + 1)
      WHEN c."id" LIKE 'conversation:%'
        THEN 'conversation:' || targets."target_provider_account_id" || ':' || substring(c."id" from 14)
      ELSE c."id" || ':account:' || targets."target_provider_account_id"
    END AS "new_conversation_id",
    targets."target_provider_account_id" AS "new_provider_account_id"
  FROM conversation_account_targets targets
  JOIN "conversations" c ON c."id" = targets."old_conversation_id"
)
SELECT *
FROM conversation_account_rekeys
WHERE "old_conversation_id" <> "new_conversation_id";

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
  clones."new_conversation_id",
  c."app_id",
  clones."new_provider_account_id",
  c."external_ref_json",
  c."kind",
  c."title",
  c."status",
  c."created_at",
  c."updated_at"
FROM "__conversation_account_clones" clones
JOIN "conversations" c ON c."id" = clones."old_conversation_id"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "conversation_threads" (
  "id",
  "app_id",
  "conversation_id",
  "external_ref_json",
  "title",
  "status",
  "created_at",
  "updated_at"
)
SELECT
  CASE
    WHEN t."id" LIKE 'thread:%'
      THEN regexp_replace(t."id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
    ELSE t."id" || ':account:' || clones."new_provider_account_id"
  END,
  t."app_id",
  clones."new_conversation_id",
  t."external_ref_json",
  t."title",
  t."status",
  t."created_at",
  t."updated_at"
FROM "conversation_threads" t
JOIN "__conversation_account_clones" clones
  ON clones."old_conversation_id" = t."conversation_id"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "conversation_participants" (
  "id",
  "app_id",
  "conversation_id",
  "user_id",
  "external_user_id",
  "role",
  "status",
  "created_at",
  "updated_at"
)
SELECT
  p."id" || ':account:' || clones."new_provider_account_id",
  p."app_id",
  clones."new_conversation_id",
  p."user_id",
  p."external_user_id",
  p."role",
  p."status",
  p."created_at",
  p."updated_at"
FROM "conversation_participants" p
JOIN "__conversation_account_clones" clones
  ON clones."old_conversation_id" = p."conversation_id"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "conversation_approvers" (
  "id",
  "app_id",
  "conversation_id",
  "external_user_id",
  "created_at",
  "updated_at"
)
SELECT
  a."id" || ':account:' || clones."new_provider_account_id",
  a."app_id",
  clones."new_conversation_id",
  a."external_user_id",
  a."created_at",
  a."updated_at"
FROM "conversation_approvers" a
JOIN "__conversation_account_clones" clones
  ON clones."old_conversation_id" = a."conversation_id"
ON CONFLICT ("app_id", "conversation_id", "external_user_id") DO NOTHING;

UPDATE "conversation_installs" ci
SET
  "conversation_id" = clones."new_conversation_id",
  "thread_id" = CASE
    WHEN ci."thread_id" IS NULL THEN NULL
    WHEN ci."thread_id" LIKE 'thread:%'
      THEN regexp_replace(ci."thread_id", '^thread:', 'thread:' || ci."provider_account_id" || ':')
    ELSE ci."thread_id" || ':account:' || ci."provider_account_id"
  END
FROM "__conversation_account_clones" clones
WHERE ci."conversation_id" = clones."old_conversation_id"
  AND ci."provider_account_id" = clones."new_provider_account_id";

ALTER INDEX IF EXISTS "idx_conversations_provider_connection"
  RENAME TO "idx_conversations_provider_account";

ALTER TABLE "messages"
  RENAME COLUMN "provider_connection_id" TO "provider_account_id";

CREATE TEMP TABLE "__message_account_clones" ON COMMIT DROP AS
SELECT
  m."id" AS "old_message_id",
  'message:' || clones."new_provider_account_id" || ':' || CASE
    WHEN NULLIF(message_ref."json" ->> 'chat_jid', '') IS NOT NULL
      AND NULLIF(message_ref."json" ->> 'id', '') IS NOT NULL
      THEN (message_ref."json" ->> 'chat_jid') || ':' || (message_ref."json" ->> 'id')
    ELSE COALESCE(NULLIF(m."external_message_id", ''), m."id")
  END AS "new_message_id",
  clones."new_provider_account_id",
  clones."new_conversation_id",
  CASE
    WHEN m."thread_id" IS NULL THEN NULL
    WHEN m."thread_id" LIKE 'thread:%'
      THEN regexp_replace(m."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
    ELSE m."thread_id" || ':account:' || clones."new_provider_account_id"
  END AS "new_thread_id"
FROM "messages" m
JOIN "__conversation_account_clones" clones
  ON clones."old_conversation_id" = m."conversation_id"
LEFT JOIN LATERAL (
  SELECT CASE
    WHEN NULLIF(btrim(m."external_ref_json"::text), '') IS NULL THEN NULL::jsonb
    WHEN btrim(m."external_ref_json"::text) ~ '^\{' THEN m."external_ref_json"::jsonb
    ELSE NULL::jsonb
  END AS "json"
) message_ref ON TRUE;

INSERT INTO "messages" (
  "id",
  "app_id",
  "provider",
  "provider_account_id",
  "conversation_id",
  "thread_id",
  "external_message_id",
  "external_ref_json",
  "direction",
  "sender_user_id",
  "sender_display_name",
  "trust",
  "created_at",
  "received_at",
  "delivery_status",
  "delivered_at",
  "delivery_error"
)
SELECT
  clones."new_message_id",
  m."app_id",
  m."provider",
  clones."new_provider_account_id",
  clones."new_conversation_id",
  clones."new_thread_id",
  m."external_message_id",
  m."external_ref_json",
  m."direction",
  m."sender_user_id",
  m."sender_display_name",
  m."trust",
  m."created_at",
  m."received_at",
  m."delivery_status",
  m."delivered_at",
  m."delivery_error"
FROM "messages" m
JOIN "__message_account_clones" clones
  ON clones."old_message_id" = m."id"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "message_parts" (
  "message_id",
  "ordinal",
  "kind",
  "payload_json"
)
SELECT
  clones."new_message_id",
  mp."ordinal",
  mp."kind",
  mp."payload_json"
FROM "message_parts" mp
JOIN "__message_account_clones" clones
  ON clones."old_message_id" = mp."message_id"
ON CONFLICT ("message_id", "ordinal") DO NOTHING;

INSERT INTO "message_attachments" (
  "id",
  "message_id",
  "kind",
  "content_type",
  "size_bytes",
  "external_ref_json",
  "storage_ref",
  "trust"
)
SELECT
  ma."id" || ':account:' || clones."new_provider_account_id",
  clones."new_message_id",
  ma."kind",
  ma."content_type",
  ma."size_bytes",
  ma."external_ref_json",
  ma."storage_ref",
  ma."trust"
FROM "message_attachments" ma
JOIN "__message_account_clones" clones
  ON clones."old_message_id" = ma."message_id"
ON CONFLICT ("id") DO NOTHING;

CREATE TEMP TABLE "__session_account_clones" ON COMMIT DROP AS
WITH session_targets AS (
  SELECT
    s."id" AS "old_session_id",
    s."app_id",
    s."agent_id",
    s."conversation_id" AS "old_conversation_id",
    s."thread_id" AS "old_thread_id",
    s."scope_key",
    clones."new_conversation_id",
    clones."new_provider_account_id",
    CASE
      WHEN s."thread_id" IS NULL THEN NULL
      WHEN s."thread_id" LIKE 'thread:%'
        THEN regexp_replace(s."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
      ELSE s."thread_id" || ':account:' || clones."new_provider_account_id"
    END AS "new_thread_id",
    replace(replace(clones."new_provider_account_id", ':', '%3A'), '/', '%2F') AS "encoded_provider_account_id",
    replace(replace(s."agent_id", ':', '%3A'), '/', '%2F') AS "encoded_agent_id",
    replace(replace(s."app_id", ':', '%3A'), '/', '%2F') AS "encoded_app_id"
  FROM "agent_sessions" s
  JOIN "__conversation_account_clones" clones
    ON clones."old_conversation_id" = s."conversation_id"
  JOIN "provider_accounts" pa
    ON pa."app_id" = s."app_id"
   AND pa."id" = clones."new_provider_account_id"
   AND pa."agent_id" = s."agent_id"
  WHERE s."scope_key" IS NOT NULL
),
session_rekeys AS (
  SELECT
    *,
    CASE
      WHEN "scope_key" LIKE '%::provider_account:%' THEN "scope_key"
      WHEN "scope_key" LIKE '%::conversation:%'
        THEN regexp_replace(
          "scope_key",
          '(::conversation:[^:]+)',
          '\1::provider_account:' || "encoded_provider_account_id"
        )
      ELSE "scope_key" || '::provider_account:' || "encoded_provider_account_id"
    END AS "new_scope_key"
  FROM session_targets
)
SELECT
  *,
  'agent-session:' ||
  CASE
    WHEN "app_id" = 'default' THEN ''
    ELSE 'app:' || "encoded_app_id" || '::'
  END ||
  'agent:' || "encoded_agent_id" || '::' || "new_scope_key" AS "new_session_id"
FROM session_rekeys
WHERE "old_session_id" <>
  'agent-session:' ||
  CASE
    WHEN "app_id" = 'default' THEN ''
    ELSE 'app:' || "encoded_app_id" || '::'
  END ||
  'agent:' || "encoded_agent_id" || '::' || "new_scope_key";

INSERT INTO "agent_sessions" (
  "id",
  "app_id",
  "agent_id",
  "conversation_id",
  "thread_id",
  "job_id",
  "user_id",
  "scope_key",
  "latest_provider_session_id",
  "status",
  "model_override",
  "created_at",
  "updated_at",
  "reset_at"
)
SELECT
  clones."new_session_id",
  s."app_id",
  s."agent_id",
  clones."new_conversation_id",
  clones."new_thread_id",
  s."job_id",
  s."user_id",
  clones."new_scope_key",
  s."latest_provider_session_id",
  s."status",
  s."model_override",
  s."created_at",
  s."updated_at",
  s."reset_at"
FROM "agent_sessions" s
JOIN "__session_account_clones" clones
  ON clones."old_session_id" = s."id"
ON CONFLICT ("id") DO UPDATE SET
  "latest_provider_session_id" = COALESCE(
    "agent_sessions"."latest_provider_session_id",
    EXCLUDED."latest_provider_session_id"
  ),
  "reset_at" = COALESCE("agent_sessions"."reset_at", EXCLUDED."reset_at"),
  "updated_at" = GREATEST("agent_sessions"."updated_at", EXCLUDED."updated_at");

UPDATE "provider_sessions" ps
SET "agent_session_id" = clones."new_session_id"
FROM "__session_account_clones" clones
WHERE ps."agent_session_id" = clones."old_session_id";

UPDATE "agent_session_summaries" summaries
SET "agent_session_id" = clones."new_session_id"
FROM "__session_account_clones" clones
WHERE summaries."agent_session_id" = clones."old_session_id";

UPDATE "agent_session_digests" digests
SET
  "agent_session_id" = clones."new_session_id",
  "scope_conversation_id" = CASE
    WHEN digests."scope_conversation_id" = clones."old_conversation_id"
      THEN clones."new_conversation_id"
    ELSE digests."scope_conversation_id"
  END,
  "scope_thread_id" = CASE
    WHEN digests."scope_thread_id" = clones."old_thread_id"
      THEN clones."new_thread_id"
    ELSE digests."scope_thread_id"
  END
FROM "__session_account_clones" clones
WHERE digests."agent_session_id" = clones."old_session_id";

UPDATE "jobs" j
SET
  "conversation_id" = clones."new_conversation_id",
  "thread_id" = CASE
    WHEN j."thread_id" IS NULL THEN NULL
    WHEN j."thread_id" LIKE 'thread:%'
      THEN regexp_replace(j."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
    ELSE j."thread_id" || ':account:' || clones."new_provider_account_id"
  END
FROM "__conversation_account_clones" clones
JOIN "provider_accounts" pa ON pa."id" = clones."new_provider_account_id"
JOIN "conversations" old_conversation ON old_conversation."id" = clones."old_conversation_id"
WHERE j."conversation_id" = clones."old_conversation_id"
  AND (
    j."agent_id" = pa."agent_id"
    OR (j."agent_id" IS NULL AND old_conversation."provider_account_id" = clones."new_provider_account_id")
  );

UPDATE "outbound_deliveries" od
SET
  "conversation_id" = clones."new_conversation_id",
  "thread_id" = CASE
    WHEN od."thread_id" IS NULL THEN NULL
    WHEN od."thread_id" LIKE 'thread:%'
      THEN regexp_replace(od."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
    ELSE od."thread_id" || ':account:' || clones."new_provider_account_id"
  END
FROM "__conversation_account_clones" clones
JOIN "provider_accounts" pa ON pa."id" = clones."new_provider_account_id"
JOIN "conversations" old_conversation ON old_conversation."id" = clones."old_conversation_id"
WHERE od."conversation_id" = clones."old_conversation_id"
  AND (
    od."agent_id" = pa."agent_id"
    OR (od."agent_id" IS NULL AND old_conversation."provider_account_id" = clones."new_provider_account_id")
  );

UPDATE "agent_runs" ar
SET
  "session_id" = COALESCE(
    (
      SELECT session_clones."new_session_id"
      FROM "__session_account_clones" session_clones
      WHERE session_clones."old_session_id" = ar."session_id"
        AND session_clones."new_provider_account_id" = clones."new_provider_account_id"
      LIMIT 1
    ),
    ar."session_id"
  ),
  "conversation_id" = clones."new_conversation_id",
  "thread_id" = CASE
    WHEN ar."thread_id" IS NULL THEN NULL
    WHEN ar."thread_id" LIKE 'thread:%'
      THEN regexp_replace(ar."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
    ELSE ar."thread_id" || ':account:' || clones."new_provider_account_id"
  END,
  "message_id" = COALESCE(
    (
      SELECT message_clones."new_message_id"
      FROM "__message_account_clones" message_clones
      WHERE message_clones."old_message_id" = ar."message_id"
        AND message_clones."new_provider_account_id" = clones."new_provider_account_id"
      LIMIT 1
    ),
    ar."message_id"
  )
FROM "__conversation_account_clones" clones
JOIN "provider_accounts" pa ON pa."id" = clones."new_provider_account_id"
WHERE ar."conversation_id" = clones."old_conversation_id"
  AND ar."agent_id" = pa."agent_id";

UPDATE "runtime_events" re
SET
  "session_id" = COALESCE(
    (
      SELECT session_clones."new_session_id"
      FROM "__session_account_clones" session_clones
      WHERE session_clones."old_session_id" = re."session_id"
        AND session_clones."new_provider_account_id" = clones."new_provider_account_id"
      LIMIT 1
    ),
    re."session_id"
  ),
  "conversation_id" = clones."new_conversation_id",
  "thread_id" = CASE
    WHEN re."thread_id" IS NULL THEN NULL
    WHEN re."thread_id" LIKE 'thread:%'
      THEN regexp_replace(re."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
    ELSE re."thread_id" || ':account:' || clones."new_provider_account_id"
  END
FROM "__conversation_account_clones" clones
JOIN "provider_accounts" pa ON pa."id" = clones."new_provider_account_id"
JOIN "conversations" old_conversation ON old_conversation."id" = clones."old_conversation_id"
WHERE re."conversation_id" = clones."old_conversation_id"
  AND (
    re."agent_id" = pa."agent_id"
    OR (re."agent_id" IS NULL AND old_conversation."provider_account_id" = clones."new_provider_account_id")
  );

UPDATE "live_turns" lt
SET
  "agent_session_id" = COALESCE(
    (
      SELECT session_clones."new_session_id"
      FROM "__session_account_clones" session_clones
      WHERE session_clones."old_session_id" = lt."agent_session_id"
        AND session_clones."new_provider_account_id" = clones."new_provider_account_id"
      LIMIT 1
    ),
    lt."agent_session_id"
  ),
  "conversation_id" = clones."new_conversation_id",
  "thread_id" = CASE
    WHEN lt."thread_id" IS NULL THEN NULL
    WHEN lt."thread_id" LIKE 'thread:%'
      THEN regexp_replace(lt."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
    ELSE lt."thread_id" || ':account:' || clones."new_provider_account_id"
  END,
  "scope_key" = replace(
    replace(
      lt."scope_key",
      'conv:' || replace(replace(clones."old_conversation_id", ':', '%3A'), '/', '%2F'),
      'conv:' || replace(replace(clones."new_conversation_id", ':', '%3A'), '/', '%2F')
    ),
    CASE
      WHEN lt."thread_id" IS NULL THEN 'thread:'
      ELSE 'thread:' || replace(replace(lt."thread_id", ':', '%3A'), '/', '%2F')
    END,
    CASE
      WHEN lt."thread_id" IS NULL THEN 'thread:'
      ELSE 'thread:' || replace(replace(
        CASE
          WHEN lt."thread_id" LIKE 'thread:%'
            THEN regexp_replace(lt."thread_id", '^thread:', 'thread:' || clones."new_provider_account_id" || ':')
          ELSE lt."thread_id" || ':account:' || clones."new_provider_account_id"
        END,
        ':',
        '%3A'
      ), '/', '%2F')
    END
  )
FROM "__conversation_account_clones" clones
JOIN "provider_accounts" pa ON pa."id" = clones."new_provider_account_id"
WHERE lt."conversation_id" = clones."old_conversation_id"
  AND (
    EXISTS (
      SELECT 1
      FROM "__session_account_clones" session_clones
      WHERE session_clones."old_session_id" = lt."agent_session_id"
        AND session_clones."new_provider_account_id" = clones."new_provider_account_id"
    )
    OR lt."agent_session_id" IS NULL
    OR pa."agent_id" = (
      SELECT s."agent_id"
      FROM "agent_sessions" s
      WHERE s."id" = lt."agent_session_id"
      LIMIT 1
    )
  );

UPDATE "live_admission_work_items" lawi
SET
  "agent_session_id" = COALESCE(
    (
      SELECT session_clones."new_session_id"
      FROM "__session_account_clones" session_clones
      WHERE session_clones."old_session_id" = lawi."agent_session_id"
        AND session_clones."new_provider_account_id" = clones."new_provider_account_id"
      LIMIT 1
    ),
    lawi."agent_session_id"
  ),
  "queue_jid" =
    regexp_replace(lawi."queue_jid", '::provider_account:[^:]*$', '')
    || '::provider_account:' || replace(replace(clones."new_provider_account_id", ':', '%3A'), '/', '%2F'),
  "idempotency_key" =
    regexp_replace(lawi."idempotency_key", '::provider_account:[^:]*$', '')
    || '::provider_account:' || replace(replace(clones."new_provider_account_id", ':', '%3A'), '/', '%2F'),
  "message_id" = COALESCE(
    (
      SELECT message_clones."new_message_id"
      FROM "__message_account_clones" message_clones
      WHERE message_clones."old_message_id" = lawi."message_id"
        AND message_clones."new_provider_account_id" = clones."new_provider_account_id"
      LIMIT 1
    ),
    lawi."message_id"
  )
FROM "__conversation_account_clones" clones
JOIN "provider_accounts" pa ON pa."id" = clones."new_provider_account_id"
JOIN "conversations" old_conversation ON old_conversation."id" = clones."old_conversation_id"
JOIN LATERAL (
  SELECT CASE
    WHEN NULLIF(btrim(old_conversation."external_ref_json"), '') IS NULL THEN '{}'::jsonb
    WHEN btrim(old_conversation."external_ref_json") ~ '^\{' THEN old_conversation."external_ref_json"::jsonb
    ELSE '{}'::jsonb
  END AS ref
) old_ref ON TRUE
WHERE lawi."conversation_id" IN (
    clones."old_conversation_id",
    CASE
      WHEN clones."old_conversation_id" LIKE 'conversation:%'
        THEN substring(clones."old_conversation_id" from 14)
      ELSE NULL
    END,
    NULLIF(old_ref.ref ->> 'jid', ''),
    NULLIF(old_ref.ref ->> 'value', ''),
    CASE
      WHEN NULLIF(old_ref.ref ->> 'value', '') IS NULL THEN NULL
      WHEN old_ref.ref ->> 'value' LIKE '%:%' THEN old_ref.ref ->> 'value'
      WHEN pa."provider_id" = 'slack' THEN 'sl:' || (old_ref.ref ->> 'value')
      WHEN pa."provider_id" = 'telegram' THEN 'tg:' || (old_ref.ref ->> 'value')
      WHEN pa."provider_id" = 'teams' THEN 'teams:' || (old_ref.ref ->> 'value')
      WHEN pa."provider_id" = 'discord' THEN 'dc:' || (old_ref.ref ->> 'value')
      WHEN pa."provider_id" = 'whatsapp' THEN 'wa:' || (old_ref.ref ->> 'value')
      ELSE NULL
    END
  )
  AND (
    lawi."agent_id" = pa."agent_id"
    OR lawi."agent_id" IS NULL
  );

UPDATE "conversations" c
SET "status" = 'disabled'
FROM "__conversation_account_clones" clones
WHERE c."id" = clones."old_conversation_id"
  AND NOT EXISTS (
    SELECT 1
    FROM "conversation_installs" ci
    WHERE ci."conversation_id" = c."id"
      AND ci."provider_account_id" = c."provider_account_id"
      AND ci."status" = 'active'
  );

ALTER INDEX IF EXISTS "idx_messages_external_redelivery_unique"
  RENAME TO "idx_messages_external_redelivery_unique_old";

CREATE UNIQUE INDEX "idx_messages_external_redelivery_unique"
  ON "messages"("provider", "provider_account_id", "conversation_id", COALESCE("thread_id", ''), "external_message_id")
  WHERE "external_message_id" IS NOT NULL;

DROP INDEX IF EXISTS "idx_messages_external_redelivery_unique_old";

ALTER TABLE "user_aliases"
  RENAME COLUMN "provider_connection_id" TO "provider_account_id";

DROP TABLE IF EXISTS "agent_conversation_bindings";
DROP TABLE IF EXISTS "provider_connections";
