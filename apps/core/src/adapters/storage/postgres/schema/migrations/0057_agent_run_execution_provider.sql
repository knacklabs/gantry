ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS execution_provider_id text DEFAULT 'anthropic:claude-agent-sdk',
  ADD COLUMN IF NOT EXISTS provider_run_id text,
  ADD COLUMN IF NOT EXISTS provider_session_id text,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE agent_runs
  ALTER COLUMN execution_provider_id SET DEFAULT 'anthropic:claude-agent-sdk';

DO $$
DECLARE
  rows_updated integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ctid
      FROM agent_runs
      WHERE execution_provider_id IS NULL
      LIMIT 10000
    )
    UPDATE agent_runs
    SET execution_provider_id = 'anthropic:claude-agent-sdk'
    WHERE ctid IN (SELECT ctid FROM batch);

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_execution_provider_id_safe,
  ADD CONSTRAINT agent_runs_execution_provider_id_safe
    CHECK (
      execution_provider_id IS NOT NULL
      AND execution_provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$'
    ) NOT VALID;

ALTER TABLE agent_runs
  VALIDATE CONSTRAINT agent_runs_execution_provider_id_safe;
