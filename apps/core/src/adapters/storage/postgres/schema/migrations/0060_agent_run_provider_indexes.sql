-- Drizzle's node-postgres migrator runs migration files in a transaction, so
-- these indexes intentionally avoid CONCURRENTLY. Keep this file index-only so
-- a future non-transactional migration runner can move them to CONCURRENTLY
-- without coupling that change to data backfills.

DROP INDEX IF EXISTS idx_agent_runs_execution_provider;

CREATE INDEX IF NOT EXISTS idx_agent_runs_provider_session
  ON agent_runs(provider_session_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_lease_claim
  ON agent_runs(status, lease_expires_at, lease_owner)
  WHERE status IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS idx_provider_sessions_agent_provider
  ON provider_sessions(agent_session_id, provider);
