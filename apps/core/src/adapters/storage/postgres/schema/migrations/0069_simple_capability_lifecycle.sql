ALTER TABLE skill_catalog
  ALTER COLUMN status SET DEFAULT 'installed';

UPDATE skill_catalog
SET status = CASE
  WHEN status IN ('active', 'approved') THEN 'installed'
  WHEN status IN ('draft', 'rejected') THEN 'disabled'
  ELSE status
END;

ALTER TABLE skill_catalog
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS rejected_by,
  DROP COLUMN IF EXISTS rejected_at;

DROP INDEX IF EXISTS idx_skill_catalog_app_name_version;
DROP INDEX IF EXISTS idx_skill_catalog_app_hash;

ALTER TABLE skill_catalog
  DROP COLUMN IF EXISTS version;

WITH ranked_skill_slugs AS (
  SELECT
    skill_catalog.id,
    first_value(skill_catalog.id) OVER (
      PARTITION BY
        skill_catalog.app_id,
        lower(regexp_replace(regexp_replace(trim(skill_catalog.name), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))
      ORDER BY
        EXISTS (
          SELECT 1
          FROM agent_skill_bindings AS active_binding
          WHERE active_binding.skill_id = skill_catalog.id
            AND active_binding.status = 'active'
        ) DESC,
        skill_catalog.updated_at DESC,
        skill_catalog.created_at DESC,
        skill_catalog.id DESC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY
        skill_catalog.app_id,
        lower(regexp_replace(regexp_replace(trim(skill_catalog.name), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))
      ORDER BY
        EXISTS (
          SELECT 1
          FROM agent_skill_bindings AS active_binding
          WHERE active_binding.skill_id = skill_catalog.id
            AND active_binding.status = 'active'
        ) DESC,
        skill_catalog.updated_at DESC,
        skill_catalog.created_at DESC,
        skill_catalog.id DESC
    ) AS rank
  FROM skill_catalog
  WHERE skill_catalog.status = 'installed'
),
duplicate_skill_slugs AS (
  SELECT id, keep_id
  FROM ranked_skill_slugs
  WHERE rank > 1
),
repointable_bindings AS (
  SELECT duplicate_binding.id AS binding_id, duplicate_skill_slugs.keep_id
  FROM agent_skill_bindings AS duplicate_binding
  JOIN duplicate_skill_slugs
    ON duplicate_skill_slugs.id = duplicate_binding.skill_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM agent_skill_bindings AS existing_binding
    WHERE existing_binding.app_id = duplicate_binding.app_id
      AND existing_binding.agent_id = duplicate_binding.agent_id
      AND existing_binding.skill_id = duplicate_skill_slugs.keep_id
  )
)
UPDATE agent_skill_bindings AS binding
SET skill_id = repointable_bindings.keep_id
FROM repointable_bindings
WHERE binding.id = repointable_bindings.binding_id;

WITH ranked_skill_slugs AS (
  SELECT
    skill_catalog.id,
    first_value(skill_catalog.id) OVER (
      PARTITION BY
        skill_catalog.app_id,
        lower(regexp_replace(regexp_replace(trim(skill_catalog.name), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))
      ORDER BY
        EXISTS (
          SELECT 1
          FROM agent_skill_bindings AS active_binding
          WHERE active_binding.skill_id = skill_catalog.id
            AND active_binding.status = 'active'
        ) DESC,
        skill_catalog.updated_at DESC,
        skill_catalog.created_at DESC,
        skill_catalog.id DESC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY
        skill_catalog.app_id,
        lower(regexp_replace(regexp_replace(trim(skill_catalog.name), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))
      ORDER BY
        EXISTS (
          SELECT 1
          FROM agent_skill_bindings AS active_binding
          WHERE active_binding.skill_id = skill_catalog.id
            AND active_binding.status = 'active'
        ) DESC,
        skill_catalog.updated_at DESC,
        skill_catalog.created_at DESC,
        skill_catalog.id DESC
    ) AS rank
  FROM skill_catalog
  WHERE skill_catalog.status = 'installed'
),
duplicate_skill_slugs AS (
  SELECT id
  FROM ranked_skill_slugs
  WHERE rank > 1
)
UPDATE agent_skill_bindings AS binding
SET status = 'disabled', updated_at = now()
FROM duplicate_skill_slugs
WHERE binding.skill_id = duplicate_skill_slugs.id;

WITH ranked_skill_slugs AS (
  SELECT
    skill_catalog.id,
    row_number() OVER (
      PARTITION BY
        skill_catalog.app_id,
        lower(regexp_replace(regexp_replace(trim(skill_catalog.name), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))
      ORDER BY
        EXISTS (
          SELECT 1
          FROM agent_skill_bindings AS active_binding
          WHERE active_binding.skill_id = skill_catalog.id
            AND active_binding.status = 'active'
        ) DESC,
        skill_catalog.updated_at DESC,
        skill_catalog.created_at DESC,
        skill_catalog.id DESC
    ) AS rank
  FROM skill_catalog
  WHERE skill_catalog.status = 'installed'
)
UPDATE skill_catalog
SET status = 'disabled', updated_at = now()
FROM ranked_skill_slugs
WHERE skill_catalog.id = ranked_skill_slugs.id
  AND ranked_skill_slugs.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_app_skill_slug_installed
  ON skill_catalog(
    app_id,
    lower(regexp_replace(regexp_replace(trim(name), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))
  )
  WHERE status = 'installed';

ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'stdio_template',
  ADD COLUMN IF NOT EXISTS config_json text NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allowed_tool_patterns_json text NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS auto_approve_tool_patterns_json text NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS credential_refs_json text NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS sandbox_profile_id text;

DO $$
BEGIN
  IF to_regclass('mcp_server_versions') IS NOT NULL THEN
    WITH chosen AS (
      SELECT DISTINCT ON (versions.server_id)
        versions.server_id,
        versions.transport,
        versions.config_json,
        versions.allowed_tool_patterns_json,
        versions.auto_approve_tool_patterns_json,
        versions.credential_refs_json,
        versions.sandbox_profile_id
      FROM mcp_server_versions AS versions
      JOIN mcp_servers AS servers
        ON servers.id = versions.server_id
      ORDER BY
        versions.server_id,
        (versions.id = servers.latest_approved_version_id) DESC,
        versions.version DESC
    )
    UPDATE mcp_servers AS servers
    SET
      transport = chosen.transport,
      config_json = chosen.config_json,
      allowed_tool_patterns_json = chosen.allowed_tool_patterns_json,
      auto_approve_tool_patterns_json = chosen.auto_approve_tool_patterns_json,
      credential_refs_json = chosen.credential_refs_json,
      sandbox_profile_id = chosen.sandbox_profile_id
    FROM chosen
    WHERE chosen.server_id = servers.id;
  END IF;
END $$;

ALTER TABLE mcp_servers
  ALTER COLUMN status SET DEFAULT 'active';

UPDATE mcp_servers
SET status = CASE
  WHEN status IN ('approved', 'active') THEN 'active'
  WHEN status IN ('rejected', 'disabled') THEN 'disabled'
  WHEN status = 'draft' THEN 'disabled'
  ELSE status
END;

ALTER TABLE agent_mcp_server_bindings
  DROP COLUMN IF EXISTS version_id;

ALTER TABLE mcp_server_audit_events
  DROP COLUMN IF EXISTS version_id;

ALTER TABLE mcp_servers
  DROP COLUMN IF EXISTS latest_approved_version_id,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS rejected_by,
  DROP COLUMN IF EXISTS rejected_at;

DROP TABLE IF EXISTS mcp_server_versions;
