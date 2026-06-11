#!/bin/sh
# Gantry container entrypoint.
#
# 1. Run database migrations under a Postgres advisory lock (race-safe across a
#    rolling deploy), unless GANTRY_SKIP_MIGRATIONS=1.
# 2. exec the runtime as PID 1 so SIGTERM reaches it directly and graceful drain
#    (control server: SIGTERM -> /readyz 503 -> drain -> exit) works correctly.
#
# Fail fast: any unset var or failed command aborts before the runtime starts.
set -eu

log() {
  # ISO-8601 UTC, single line, to stderr (keeps stdout for the runtime).
  printf '%s [entrypoint] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

# ---------------------------------------------------------------------------
# Migrations.
#
# Default: every instance runs migrations. The advisory lock inside migrate.mjs
# serializes them, and migrate() is idempotent (drizzle tracks applied
# migrations), so N workers booting at once is safe — the lock holder migrates,
# the rest block then find nothing pending.
#
# GANTRY_SKIP_MIGRATIONS=1: skip the explicit migrate step. Use this for an
# N-worker fleet where one dedicated migrator (or the first booting worker)
# already applied the schema. Note: the runtime ALSO runs an idempotent
# boot-time migrate(); skipping here just avoids the redundant explicit pass.
# ---------------------------------------------------------------------------
if [ "${GANTRY_SKIP_MIGRATIONS:-0}" = "1" ]; then
  log "GANTRY_SKIP_MIGRATIONS=1 — skipping explicit migration step"
else
  # The migration role may differ from the runtime role: migrate.mjs prefers
  # MIGRATION_DATABASE_URL, falling back to GANTRY_DATABASE_URL.
  if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
    log "running migrations (MIGRATION_DATABASE_URL)"
  else
    log "running migrations (GANTRY_DATABASE_URL)"
  fi
  # Non-zero exit here aborts the container before the runtime starts.
  node /app/ops/docker/migrate.mjs
  log "migrations complete"
fi

# ---------------------------------------------------------------------------
# Hand off to the runtime as PID 1. `exec` replaces this shell so the runtime
# receives SIGTERM directly (graceful drain), with no shell sitting between
# the orchestrator and the process.
# ---------------------------------------------------------------------------
log "starting runtime: $*"
exec "$@"
