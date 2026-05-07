DROP INDEX IF EXISTS idx_skill_catalog_app_hash;
DROP INDEX IF EXISTS idx_skill_catalog_app_name_version;

WITH ranked_content_hashes AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), content_hash
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), content_hash
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_rank
  FROM skill_catalog
  WHERE content_hash IS NOT NULL
),
duplicate_content_hashes AS (
  SELECT id, keep_id
  FROM ranked_content_hashes
  WHERE row_rank > 1
),
affected_content_hash_bindings AS (
  SELECT b.id, b.app_id, b.agent_id, b.skill_id, d.keep_id, b.updated_at, b.created_at
  FROM agent_skill_bindings b
  JOIN duplicate_content_hashes d ON b.skill_id = d.id
  UNION ALL
  SELECT b.id, b.app_id, b.agent_id, b.skill_id, b.skill_id AS keep_id, b.updated_at, b.created_at
  FROM agent_skill_bindings b
  WHERE b.skill_id IN (SELECT keep_id FROM duplicate_content_hashes)
),
ranked_content_hash_bindings AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY app_id, agent_id, keep_id
      ORDER BY
        CASE WHEN skill_id = keep_id THEN 0 ELSE 1 END,
        updated_at DESC,
        created_at DESC,
        id DESC
    ) AS binding_rank
  FROM affected_content_hash_bindings
)
DELETE FROM agent_skill_bindings
WHERE id IN (
  SELECT id
  FROM ranked_content_hash_bindings
  WHERE binding_rank > 1
);

WITH ranked_content_hashes AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), content_hash
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), content_hash
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_rank
  FROM skill_catalog
  WHERE content_hash IS NOT NULL
)
UPDATE agent_skill_bindings b
SET skill_id = ranked_content_hashes.keep_id,
    updated_at = now()
FROM ranked_content_hashes
WHERE b.skill_id = ranked_content_hashes.id
  AND ranked_content_hashes.row_rank > 1;

WITH ranked_content_hashes AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), content_hash
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_rank
  FROM skill_catalog
  WHERE content_hash IS NOT NULL
)
DELETE FROM skill_catalog
WHERE id IN (
  SELECT id
  FROM ranked_content_hashes
  WHERE row_rank > 1
);

WITH ranked_names AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), name, version
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), name, version
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_rank
  FROM skill_catalog
),
duplicate_names AS (
  SELECT id, keep_id
  FROM ranked_names
  WHERE row_rank > 1
),
affected_name_bindings AS (
  SELECT b.id, b.app_id, b.agent_id, b.skill_id, d.keep_id, b.updated_at, b.created_at
  FROM agent_skill_bindings b
  JOIN duplicate_names d ON b.skill_id = d.id
  UNION ALL
  SELECT b.id, b.app_id, b.agent_id, b.skill_id, b.skill_id AS keep_id, b.updated_at, b.created_at
  FROM agent_skill_bindings b
  WHERE b.skill_id IN (SELECT keep_id FROM duplicate_names)
),
ranked_name_bindings AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY app_id, agent_id, keep_id
      ORDER BY
        CASE WHEN skill_id = keep_id THEN 0 ELSE 1 END,
        updated_at DESC,
        created_at DESC,
        id DESC
    ) AS binding_rank
  FROM affected_name_bindings
)
DELETE FROM agent_skill_bindings
WHERE id IN (
  SELECT id
  FROM ranked_name_bindings
  WHERE binding_rank > 1
);

WITH ranked_names AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), name, version
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), name, version
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_rank
  FROM skill_catalog
)
UPDATE agent_skill_bindings b
SET skill_id = ranked_names.keep_id,
    updated_at = now()
FROM ranked_names
WHERE b.skill_id = ranked_names.id
  AND ranked_names.row_rank > 1;

WITH ranked_names AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY app_id, coalesce(agent_id, ''), name, version
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_rank
  FROM skill_catalog
)
DELETE FROM skill_catalog
WHERE id IN (
  SELECT id
  FROM ranked_names
  WHERE row_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_app_hash
  ON skill_catalog(app_id, (coalesce(agent_id, '')), content_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_catalog_app_name_version
  ON skill_catalog(app_id, (coalesce(agent_id, '')), name, version);
