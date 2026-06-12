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

rand_base64_32() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
}

rand_hex_32() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

load_or_create_rehearsal_secrets() {
  secret_file="${GANTRY_FLEET_REHEARSAL_SECRETS_FILE:-/var/lib/gantry/fleet-rehearsal-secrets.env}"
  lock_dir="${secret_file}.lock"
  mkdir -p "$(dirname "$secret_file")"

  while ! mkdir "$lock_dir" 2>/dev/null; do
    sleep 1
  done
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT INT TERM

  if [ -f "$secret_file" ]; then
    # shellcheck disable=SC1090
    . "$secret_file"
  else
    secret_encryption_key="${SECRET_ENCRYPTION_KEY:-$(rand_base64_32)}"
    ipc_auth_secret="${GANTRY_IPC_AUTH_SECRET:-$(rand_hex_32)}"
    control_api_keys_json="${GANTRY_CONTROL_API_KEYS_JSON:-}"
    if [ -z "$control_api_keys_json" ]; then
      token="$(rand_hex_32)"
      control_api_keys_json="[{\"kid\":\"fleet-rehearsal-admin\",\"token\":\"${token}\",\"appId\":\"default\",\"scopes\":[\"sessions:read\"]}]"
    fi
    umask 077
    {
      printf "SECRET_ENCRYPTION_KEY='%s'\n" "$secret_encryption_key"
      printf "GANTRY_IPC_AUTH_SECRET='%s'\n" "$ipc_auth_secret"
      printf "GANTRY_CONTROL_API_KEYS_JSON='%s'\n" "$control_api_keys_json"
    } >"$secret_file"
    # shellcheck disable=SC1090
    . "$secret_file"
  fi

  rmdir "$lock_dir"
  trap - EXIT INT TERM
}

if [ "${GANTRY_FLEET_REHEARSAL_AUTO_SECRETS:-0}" = "1" ]; then
  load_or_create_rehearsal_secrets
  export SECRET_ENCRYPTION_KEY GANTRY_IPC_AUTH_SECRET GANTRY_CONTROL_API_KEYS_JSON
  log "loaded shared rehearsal-only runtime secrets"
fi

# ---------------------------------------------------------------------------
# Migrations.
#
# Default: every instance runs migrations. The advisory lock inside migrate()
# itself (storage-service) serializes every migrator — explicit passes like
# this one and runtime boot-time migrations alike — and migrate() is
# idempotent (drizzle tracks applied migrations), so N workers booting at once
# is safe: the lock holder migrates, the rest block then find nothing pending.
#
# GANTRY_SKIP_MIGRATIONS=1: skip the explicit migrate step. Use this for an
# N-worker fleet where one dedicated migrator (or the first booting worker)
# already applied the schema. Still safe under concurrent boots: the runtime's
# boot-time migrate() takes the same advisory lock, so skipping here only
# avoids the redundant explicit pass.
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
