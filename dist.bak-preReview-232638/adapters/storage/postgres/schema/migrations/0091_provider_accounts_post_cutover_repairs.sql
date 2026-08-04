DO $$
DECLARE
  revision_record record;
  doc jsonb;
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
  default_agent_id text;
  provider_account_id text;
  install_provider_account_id text;
  source_provider_account_id text;
  binding_agent_id text;
  binding_jid text;
  binding_external_id text;
  installed_agents_doc jsonb;
BEGIN
  FOR revision_record IN
    SELECT "app_id", "revision", "settings_document_json"
    FROM "settings_revisions"
    WHERE "settings_document_json" ? 'provider_connections'
      OR "settings_document_json" ? 'bindings'
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(COALESCE("settings_document_json" -> 'agents', '{}'::jsonb)) a
        WHERE a.value ? 'bindings'
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(COALESCE("settings_document_json" -> 'providers', '{}'::jsonb)) p
        WHERE p.value ? 'default_connection'
          OR p.value ? 'defaultConnection'
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
          IF install_provider_account_id IS NOT NULL
            AND binding_agent_id IS NOT NULL
            AND provider_accounts_doc ? install_provider_account_id
            AND COALESCE(provider_accounts_doc -> install_provider_account_id ->> 'agent', '') <> binding_agent_id
          THEN
            source_provider_account_id := install_provider_account_id;
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
            IF install_provider_account_id IS NOT NULL
              AND provider_accounts_doc ? install_provider_account_id
              AND COALESCE(provider_accounts_doc -> install_provider_account_id ->> 'agent', '') <> binding_agent_id
            THEN
              source_provider_account_id := install_provider_account_id;
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
  pa."id" || ':agent:' || regexp_replace(ci."agent_id", '^agent:', ''),
  pa."app_id",
  ci."agent_id",
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
  SELECT DISTINCT "app_id", "provider_account_id", "agent_id"
  FROM "conversation_installs"
) ci ON ci."app_id" = pa."app_id"
  AND ci."provider_account_id" = pa."id"
WHERE ci."agent_id" <> pa."agent_id"
ON CONFLICT ("id") DO NOTHING;

UPDATE "conversation_installs" ci
SET "provider_account_id" = pa."id" || ':agent:' || regexp_replace(ci."agent_id", '^agent:', '')
FROM "provider_accounts" pa
WHERE ci."app_id" = pa."app_id"
  AND ci."provider_account_id" = pa."id"
  AND ci."agent_id" <> pa."agent_id";
