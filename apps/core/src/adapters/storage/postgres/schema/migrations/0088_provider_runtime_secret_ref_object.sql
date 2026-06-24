ALTER TABLE "provider_connections"
  ALTER COLUMN "runtime_secret_refs_json" SET DEFAULT '{}';

WITH refs AS (
  SELECT
    "provider_connections"."id",
    "provider_connections"."provider_id",
    item.value AS ref_value,
    item.ordinality
  FROM "provider_connections"
  CROSS JOIN LATERAL jsonb_array_elements_text(
    "provider_connections"."runtime_secret_refs_json"::jsonb
  ) WITH ORDINALITY AS item(value, ordinality)
  WHERE left(btrim("provider_connections"."runtime_secret_refs_json"), 1) = '['
),
keyed_refs AS (
  SELECT
    "id",
    CASE
      WHEN "provider_id" = 'telegram' AND ordinality = 1 THEN 'bot_token'
      WHEN "provider_id" = 'slack' AND ref_value ILIKE '%APP_TOKEN%' THEN 'app_token'
      WHEN "provider_id" = 'slack' AND ref_value ILIKE '%BOT_TOKEN%' THEN 'bot_token'
      WHEN "provider_id" = 'slack' AND ordinality = 1 THEN 'bot_token'
      WHEN "provider_id" = 'slack' AND ordinality = 2 THEN 'app_token'
      WHEN "provider_id" = 'teams' AND ref_value ILIKE '%CLIENT_SECRET%' THEN 'client_secret'
      WHEN "provider_id" = 'teams' AND ref_value ILIKE '%CLIENT_ID%' THEN 'client_id'
      WHEN "provider_id" = 'teams' AND ref_value ILIKE '%TENANT_ID%' THEN 'tenant_id'
      WHEN "provider_id" = 'teams' AND ordinality = 1 THEN 'client_id'
      WHEN "provider_id" = 'teams' AND ordinality = 2 THEN 'client_secret'
      WHEN "provider_id" = 'teams' AND ordinality = 3 THEN 'tenant_id'
      WHEN "provider_id" = 'discord' AND ref_value ILIKE '%APPLICATION_ID%' THEN 'application_id'
      WHEN "provider_id" = 'discord' AND ref_value ILIKE '%BOT_TOKEN%' THEN 'bot_token'
      WHEN "provider_id" = 'discord' AND ordinality = 1 THEN 'bot_token'
      WHEN "provider_id" = 'discord' AND ordinality = 2 THEN 'application_id'
      ELSE NULL
    END AS ref_key,
    CASE
      WHEN ref_value ~ '^(env|gantry-secret|aws-sm):' THEN ref_value
      ELSE 'env:' || ref_value
    END AS ref_value
  FROM refs
),
mapped_refs AS (
  SELECT
    "id",
    jsonb_object_agg(ref_key, ref_value) FILTER (WHERE ref_key IS NOT NULL) AS refs
  FROM keyed_refs
  GROUP BY "id"
)
UPDATE "provider_connections"
SET "runtime_secret_refs_json" = coalesce(mapped_refs.refs, '{}'::jsonb)::text
FROM mapped_refs
WHERE "provider_connections"."id" = mapped_refs."id";

UPDATE "provider_connections"
SET "runtime_secret_refs_json" = '{}'
WHERE left(btrim("runtime_secret_refs_json"), 1) = '[';
