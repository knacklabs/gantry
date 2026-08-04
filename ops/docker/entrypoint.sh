#!/bin/sh
# Gantry container entrypoint.
#
# 1. Run database migrations under a Postgres advisory lock (race-safe across a
#    rolling deploy).
# 2. exec the runtime as PID 1 so SIGTERM reaches it directly and graceful drain
#    (control server: SIGTERM -> /readyz 503 -> drain -> exit) works correctly.
#
# Fail fast: any unset var or failed command aborts before the runtime starts.
set -eu

log() {
  # ISO-8601 UTC, single line, to stderr (keeps stdout for the runtime).
  printf '%s [entrypoint] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

prepare_runtime_home_and_drop_privileges() {
  runtime_home="${GANTRY_HOME:-/var/lib/gantry}"
  if [ "$(id -u)" != "0" ]; then
    return
  fi

  mkdir -p "$runtime_home"
  chown -R node:node "$runtime_home"
  log "prepared runtime home ${runtime_home} for node user"
  exec gosu node "$0" "$@"
}

rand_base64_32() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
}

rand_hex_32() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

resolve_settings_schema() {
  node <<'NODE'
const explicit = process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA?.trim();
if (explicit) {
  process.stdout.write(explicit);
  process.exit(0);
}
const url = process.env.GANTRY_DATABASE_URL?.trim() || '';
if (url) {
  try {
    const schema = new URL(url).searchParams.get('schema')?.trim();
    if (schema) {
      process.stdout.write(schema);
      process.exit(0);
    }
  } catch {
    // Fall through to env/default; the migrator reports malformed URLs.
  }
}
process.stdout.write(process.env.GANTRY_DB_SCHEMA?.trim() || 'gantry');
NODE
}

bootstrap_settings_if_missing() {
  BOOTSTRAPPED_SETTINGS_FILE=0
  BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE=''
  if [ "${GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING:-0}" != "1" ]; then
    return
  fi
  case "$*" in
    *dist/index.js*) ;;
    *) return ;;
  esac

  runtime_home="${GANTRY_HOME:-/var/lib/gantry}"
  settings_file="${runtime_home}/settings.yaml"
  if [ -f "$settings_file" ]; then
    return
  fi

  mkdir -p "$runtime_home"
  schema="$(resolve_settings_schema)"
  deployment_mode="${GANTRY_BOOTSTRAP_DEPLOYMENT_MODE:-${GANTRY_DEPLOYMENT_MODE:-workstation}}"
  sandbox_provider="${GANTRY_BOOTSTRAP_SANDBOX_PROVIDER:-sandbox_runtime}"
  tmp_file="${settings_file}.tmp.$$"
  umask 077
  {
    printf '%s\n' 'runtime:'
    printf '  deployment_mode: %s\n' "$deployment_mode"
    printf '%s\n' '  sandbox:'
    printf '    provider: %s\n' "$sandbox_provider"
    printf '%s\n' ''
    printf '%s\n' 'storage:'
    printf '%s\n' '  postgres:'
    printf '%s\n' '    url_env: GANTRY_DATABASE_URL'
    printf '    schema: %s\n' "$schema"
  } >"$tmp_file"
  mv "$tmp_file" "$settings_file"
  BOOTSTRAPPED_SETTINGS_FILE=1
  BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE="$deployment_mode"
  log "created bootstrap settings.yaml at ${settings_file} (schema=${schema}, deployment_mode=${deployment_mode})"
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

seed_fleet_settings_file() {
  gantry_home="${GANTRY_HOME:-/var/lib/gantry}"
  settings_file="$gantry_home/settings.yaml"

  mkdir -p "$gantry_home"
  if [ -f "$settings_file" ]; then
    log "fleet settings file already exists: $settings_file"
    return
  fi

  artifact_bucket="${GANTRY_ARTIFACT_BUCKET:-${GANTRY_ARTIFACT_BUCKET_NAME:-}}"
  artifact_region="${GANTRY_ARTIFACT_REGION:-${AWS_REGION:-}}"
  schema="$(resolve_settings_schema)"

  : "${artifact_bucket:?GANTRY_ARTIFACT_BUCKET is required when GANTRY_FLEET_SETTINGS_AUTO=1}"
  : "${artifact_region:?AWS_REGION or GANTRY_ARTIFACT_REGION is required when GANTRY_FLEET_SETTINGS_AUTO=1}"

  umask 077
  cat >"$settings_file" <<EOF
runtime:
  deployment_mode: fleet
  queue:
    max_message_runs: 6
    max_job_runs: 2
  sandbox:
    provider: sandbox_runtime
    resource_limits:
      memory_mb: 512
      max_processes: 64
  artifact_store:
    driver: s3
    bucket: $artifact_bucket
    region: $artifact_region
storage:
  postgres:
    url_env: GANTRY_DATABASE_URL
    schema: $schema
EOF
  log "seeded fleet settings file: $settings_file"
}

prepare_runtime_home_and_drop_privileges "$@"

if [ "${GANTRY_FLEET_REHEARSAL_AUTO_SECRETS:-0}" = "1" ]; then
  load_or_create_rehearsal_secrets
  export SECRET_ENCRYPTION_KEY GANTRY_IPC_AUTH_SECRET GANTRY_CONTROL_API_KEYS_JSON
  log "loaded shared rehearsal-only runtime secrets"
fi

if [ "${GANTRY_FLEET_SETTINGS_AUTO:-0}" = "1" ]; then
  seed_fleet_settings_file
fi

BOOTSTRAPPED_SETTINGS_FILE=0
BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE=''
bootstrap_settings_if_missing "$@"

# ---------------------------------------------------------------------------
# Migrations.
#
# The advisory lock inside migrate() itself (storage-service) serializes every
# explicit migrator, and migrate() is idempotent (drizzle tracks applied
# migrations), so N workers booting at once is safe: the lock holder migrates,
# the rest block then find nothing pending.
# ---------------------------------------------------------------------------
log "running migrations (GANTRY_DATABASE_URL)"
# Non-zero exit here aborts the container before the runtime starts.
node /app/dist/postgres-migrate.js
log "migrations complete"

if [ "$BOOTSTRAPPED_SETTINGS_FILE" = "1" ] && [ "$BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE" = "fleet" ]; then
  log "seeding initial fleet settings revision from bootstrap settings.yaml"
  node /app/ops/docker/fleet-settings-seed.mjs "${GANTRY_HOME:-/var/lib/gantry}/settings.yaml"
  log "fleet settings seed complete"
elif [ "$BOOTSTRAPPED_SETTINGS_FILE" = "1" ] && [ "$BOOTSTRAPPED_SETTINGS_DEPLOYMENT_MODE" = "workstation" ]; then
  log "seeding workstation settings projection from bootstrap settings.yaml"
  node /app/dist/cli/index.js settings import --file "${GANTRY_HOME:-/var/lib/gantry}/settings.yaml"
  log "workstation settings seed complete"
elif [ "${GANTRY_FLEET_SETTINGS_AUTO:-0}" = "1" ]; then
  GANTRY_FLEET_SETTINGS_SEED_IF_EMPTY=1 \
    node /app/ops/docker/fleet-settings-seed.mjs "${GANTRY_HOME:-/var/lib/gantry}/settings.yaml"
  log "fleet settings revision seed complete"
fi

# ---------------------------------------------------------------------------
# Hand off to the runtime as PID 1. `exec` replaces this shell so the runtime
# receives SIGTERM directly (graceful drain), with no shell sitting between
# the orchestrator and the process.
# ---------------------------------------------------------------------------
log "starting runtime: $*"
exec "$@"
