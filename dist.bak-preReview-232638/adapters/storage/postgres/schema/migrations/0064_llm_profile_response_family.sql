-- Irreversible clean cut: llm_profiles now stores canonical response family.
-- Route/provider distinctions are adapter metadata and are intentionally not
-- recoverable from this column after the cutover.
-- Deploy ordering: stop older runtime pods before applying this migration,
-- then deploy code that reads/writes response_family. This early-stage clean
-- cut intentionally does not support mixed provider/response_family readers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'llm_profiles'
      AND column_name = 'provider'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'llm_profiles'
      AND column_name = 'response_family'
  ) THEN
    ALTER TABLE llm_profiles
      RENAME COLUMN provider TO response_family;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'llm_profiles'
      AND column_name = 'response_family'
  ) THEN
    ALTER TABLE llm_profiles
      ADD COLUMN response_family text NOT NULL DEFAULT 'anthropic';
  END IF;
END $$;

ALTER TABLE llm_profiles
  ALTER COLUMN response_family SET DEFAULT 'anthropic',
  ALTER COLUMN response_family SET NOT NULL;

CREATE TABLE IF NOT EXISTS llm_profiles_response_family_legacy (
  id text NOT NULL,
  legacy_response_family text,
  captured_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO llm_profiles_response_family_legacy (
  id,
  legacy_response_family
)
SELECT
  profile.id,
  profile.response_family
FROM llm_profiles profile
WHERE profile.response_family IS DISTINCT FROM 'anthropic'
  AND profile.response_family IS DISTINCT FROM 'openai'
  AND NOT EXISTS (
    SELECT 1
    FROM llm_profiles_response_family_legacy snapshot
    WHERE snapshot.id = profile.id
  );

UPDATE llm_profiles
SET response_family = CASE
  WHEN response_family = 'openai' THEN 'openai'
  ELSE 'anthropic'
END
WHERE response_family IS DISTINCT FROM 'anthropic'
  AND response_family IS DISTINCT FROM 'openai';

ALTER TABLE llm_profiles
  DROP CONSTRAINT IF EXISTS llm_profiles_response_family_valid;

ALTER TABLE llm_profiles
  ADD CONSTRAINT llm_profiles_response_family_valid
  CHECK (response_family IN ('anthropic', 'openai')) NOT VALID;

ALTER TABLE llm_profiles
  VALIDATE CONSTRAINT llm_profiles_response_family_valid;
