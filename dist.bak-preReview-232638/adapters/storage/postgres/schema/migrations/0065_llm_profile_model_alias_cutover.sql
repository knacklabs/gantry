-- Irreversible clean cut: legacy public model aliases are rewritten to the
-- provider-neutral catalog alias used by runtime defaults. Snapshot rewritten
-- values for audit before coercion.
CREATE TABLE IF NOT EXISTS llm_profiles_model_alias_legacy (
  id text NOT NULL,
  legacy_model_alias text,
  captured_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO llm_profiles_model_alias_legacy (
  id,
  legacy_model_alias
)
SELECT
  profile.id,
  profile.model_alias
FROM llm_profiles profile
WHERE (
    profile.model_alias IN ('default', 'runtime-default')
    OR trim(profile.model_alias) = ''
  )
  AND NOT EXISTS (
    SELECT 1
    FROM llm_profiles_model_alias_legacy snapshot
    WHERE snapshot.id = profile.id
  );

UPDATE llm_profiles
SET model_alias = 'opus'
WHERE model_alias IN ('default', 'runtime-default')
   OR trim(model_alias) = '';
