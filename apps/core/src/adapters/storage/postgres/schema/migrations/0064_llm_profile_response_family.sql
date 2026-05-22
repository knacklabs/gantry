ALTER TABLE llm_profiles
  RENAME COLUMN provider TO response_family;

ALTER TABLE llm_profiles
  ALTER COLUMN response_family SET DEFAULT 'anthropic';

UPDATE llm_profiles
SET response_family = 'anthropic'
WHERE response_family IN ('anthropic', 'openrouter', 'anthropic:claude-agent-sdk')
   OR response_family IS NULL
   OR trim(response_family) = '';

ALTER TABLE llm_profiles
  ADD CONSTRAINT llm_profiles_response_family_valid
  CHECK (response_family IN ('anthropic', 'openai'));
