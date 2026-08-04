ALTER TABLE user_aliases
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by text,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by text,
  ADD COLUMN IF NOT EXISTS evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE user_aliases
SET verification_status = 'unverified'
WHERE verification_status IS NULL OR verification_status = '';

DROP INDEX IF EXISTS idx_user_aliases_provider_external;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM user_aliases
    WHERE retired_at IS NULL
    GROUP BY app_id, provider, COALESCE(provider_account_id, ''), external_user_id
    HAVING COUNT(DISTINCT user_id) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot create active user alias uniqueness index: duplicate aliases belong to multiple users';
  END IF;
END $$;

WITH ranked_active_aliases AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY app_id, provider, COALESCE(provider_account_id, ''), external_user_id
      ORDER BY (verification_status = 'verified') DESC, updated_at DESC, id ASC
    ) AS duplicate_rank
  FROM user_aliases
  WHERE retired_at IS NULL
)
UPDATE user_aliases AS alias
SET
  verification_status = 'retired',
  retired_at = now(),
  retired_by = 'migration:0102_duplicate_alias_retirement',
  evidence_json = COALESCE(alias.evidence_json, '{}'::jsonb) || jsonb_build_object(
    'migration', '0102_duplicate_alias_retirement',
    'reason', 'duplicate_active_alias'
  )
FROM ranked_active_aliases
WHERE alias.id = ranked_active_aliases.id
  AND ranked_active_aliases.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_aliases_active_provider_external
  ON user_aliases(app_id, provider, COALESCE(provider_account_id, ''), external_user_id)
  WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS person_merge_audit (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  source_person_id text NOT NULL,
  target_person_id text NOT NULL,
  actor text NOT NULL,
  conflict_resolution text NOT NULL,
  aliases_moved integer NOT NULL DEFAULT 0,
  memory_rows_moved integer NOT NULL DEFAULT 0,
  conflicts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_merge_audit_app_idempotency
  ON person_merge_audit(app_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_person_merge_audit_people
  ON person_merge_audit(app_id, target_person_id, source_person_id, created_at DESC);
