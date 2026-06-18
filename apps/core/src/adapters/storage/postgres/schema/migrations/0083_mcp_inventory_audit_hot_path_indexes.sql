-- Drizzle's node-postgres migrator runs migration files in a transaction, so
-- these indexes intentionally avoid CONCURRENTLY. Keep this file index-only so
-- a future non-transactional migration runner can move them to CONCURRENTLY
-- without coupling that change to data backfills.

CREATE INDEX IF NOT EXISTS "idx_mcp_servers_app_status_updated"
  ON "mcp_servers" ("app_id", "status", "updated_at" DESC);

DROP INDEX IF EXISTS "idx_mcp_servers_app_status";

CREATE INDEX IF NOT EXISTS "idx_mcp_server_audit_events_app_server_created"
  ON "mcp_server_audit_events" ("app_id", "server_id", "created_at" DESC);

DROP INDEX IF EXISTS "idx_mcp_server_audit_events_app_server";
