#!/usr/bin/env bash
# Start the local Gantry runtime plumbing smoke stack.
# TEST ONLY: dry-run outbound is enabled and messages are scoped to test phones.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${GANTRY_ENV_FILE:-$HOME/gantry/.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

GANTRY_DEV_LOG="${GANTRY_DEV_LOG:-/tmp/gantry-dev.log}"
SMOKE_ENV_FILE="${GANTRY_RUNTIME_SMOKE_ENV:-/tmp/gantry-runtime-smoke.env}"
GANTRY_CORE_COUNT="${GANTRY_CORE_COUNT:-1}"
GANTRY_RUNTIME_IPC_DIR="${GANTRY_RUNTIME_IPC_DIR:-/tmp/gantry-runtime-smoke-ipc}"
SHOPIFY_DEV_LOG="${SHOPIFY_DEV_LOG:-/tmp/mcp-shopify-dev.log}"
CRM_DEV_LOG="${CRM_DEV_LOG:-/tmp/mcp-crm-dev.log}"
GANTRY_CONTROL_PORT="${GANTRY_CONTROL_PORT:-4710}"
SHOPIFY_PORT="${SHOPIFY_PORT:-8081}"
CRM_PORT="${CRM_PORT:-8082}"
CORE_URL="${CORE_URL:-http://127.0.0.1:4710/}"
SHOPIFY_HEALTH_URL="${SHOPIFY_HEALTH_URL:-http://127.0.0.1:8081/healthz}"
CRM_HEALTH_URL="${CRM_HEALTH_URL:-http://127.0.0.1:8082/healthz}"
CALLER_IDENTITY_PHONE="${GANTRY_TEST_CALLER_IDENTITY_PHONE:-918097288633}"
CRM_RECONCILE_INTERVAL_MS="${BOONDI_CRM_RECONCILE_INTERVAL_MS:-10000}"
STOP_EXISTING="${STOP_EXISTING:-1}"

CORE_PIDS=()
CORE_PORTS=()
CORE_LOGS=()
CORE_SMOKE_ENVS=()
SHOPIFY_PID=""
CRM_PID=""

if ! [[ "$GANTRY_CORE_COUNT" =~ ^[0-9]+$ ]] || [ "$GANTRY_CORE_COUNT" -lt 1 ]; then
  echo "GANTRY_CORE_COUNT must be a positive integer"
  exit 1
fi

OPERATOR=$(node -e "import('$ROOT/scripts/lib/phones.mjs').then(m=>process.stdout.write(m.OPERATOR_LIST))") || {
  echo "could not read OPERATOR_LIST from scripts/lib/phones.mjs"
  exit 1
}

generate_smoke_token() {
  node -e "import('node:crypto').then(({randomBytes})=>process.stdout.write(randomBytes(24).toString('base64url')))"
}

control_keys_json_for_token() {
  SMOKE_CONTROL_TOKEN="$1" node -e "const token=process.env.SMOKE_CONTROL_TOKEN; process.stdout.write(JSON.stringify([{kid:'runtime-smoke',token,appId:'default',scopes:['sessions:read']}]))"
}

smoke_env_for_index() {
  local idx="$1"
  if [ "$GANTRY_CORE_COUNT" -eq 1 ]; then
    printf '%s' "$SMOKE_ENV_FILE"
  else
    printf '%s.%s' "$SMOKE_ENV_FILE" "$idx"
  fi
}

core_log_for_index() {
  local idx="$1"
  if [ "$GANTRY_CORE_COUNT" -eq 1 ]; then
    printf '%s' "$GANTRY_DEV_LOG"
  else
    printf '/tmp/gantry-dev-%s.log' "$idx"
  fi
}

write_smoke_env() {
  local smoke_env="$1"
  local core_port="$2"
  local core_log="$3"
  local token="$4"
  printf 'GANTRY_CONTROL_PORT=%s\nGANTRY_DEV_LOG=%s\nGANTRY_SMOKE_CONTROL_TOKEN=%s\n' \
    "$core_port" \
    "$core_log" \
    "$token" >"$smoke_env"
  chmod 600 "$smoke_env"
}

cleanup() {
  trap - INT TERM EXIT
  kill "${CORE_PIDS[@]}" "$SHOPIFY_PID" "$CRM_PID" 2>/dev/null || true
  wait "${CORE_PIDS[@]}" "$SHOPIFY_PID" "$CRM_PID" 2>/dev/null || true
  rm -f "${CORE_SMOKE_ENVS[@]}"
}
trap cleanup INT TERM EXIT

if [ "$STOP_EXISTING" = "1" ]; then
  pkill -f "apps/core/src/index.ts" 2>/dev/null || true
  pkill -f "packages/mcp-shopify/src/index.ts" 2>/dev/null || true
  pkill -f "packages/mcp-crm/src/index.ts" 2>/dev/null || true
  sleep 1
fi

rm -rf "$GANTRY_RUNTIME_IPC_DIR"
mkdir -p "$GANTRY_RUNTIME_IPC_DIR"
chmod 700 "$GANTRY_RUNTIME_IPC_DIR"
rm -f "$GANTRY_DEV_LOG" /tmp/gantry-dev-*.log "$SHOPIFY_DEV_LOG" "$CRM_DEV_LOG"

echo "starting shopify-api MCP (:${SHOPIFY_PORT}) -> $SHOPIFY_DEV_LOG"
(
  cd "$ROOT"
  exec env \
    -u ANTHROPIC_API_KEY \
    -u ANTHROPIC_AUTH_TOKEN \
    -u ANTHROPIC_BASE_URL \
    -u CLAUDE_CODE_OAUTH_TOKEN \
    -u OPENAI_API_KEY \
    node --enable-source-maps --import tsx "$ROOT/packages/mcp-shopify/src/index.ts"
) >"$SHOPIFY_DEV_LOG" 2>&1 &
SHOPIFY_PID=$!

echo "starting boondi-crm MCP (:${CRM_PORT}) -> $CRM_DEV_LOG"
(
  cd "$ROOT"
  exec env \
    -u ANTHROPIC_API_KEY \
    -u ANTHROPIC_AUTH_TOKEN \
    -u ANTHROPIC_BASE_URL \
    -u CLAUDE_CODE_OAUTH_TOKEN \
    -u OPENAI_API_KEY \
    BOONDI_CRM_RECONCILE_INTERVAL_MS="$CRM_RECONCILE_INTERVAL_MS" \
    node --enable-source-maps --import tsx "$ROOT/packages/mcp-crm/src/index.ts"
) >"$CRM_DEV_LOG" 2>&1 &
CRM_PID=$!

for idx in $(seq 1 "$GANTRY_CORE_COUNT"); do
  core_port=$((GANTRY_CONTROL_PORT + idx - 1))
  core_log="$(core_log_for_index "$idx")"
  smoke_env="$(smoke_env_for_index "$idx")"
  core_ipc_socket="$GANTRY_RUNTIME_IPC_DIR/core-${idx}.sock"
  smoke_token="$(generate_smoke_token)" || {
    echo "could not generate local smoke control token"
    exit 1
  }
  control_api_keys_json="$(control_keys_json_for_token "$smoke_token")" || {
    echo "could not build local smoke control key JSON"
    exit 1
  }
  write_smoke_env "$smoke_env" "$core_port" "$core_log" "$smoke_token"
  CORE_PORTS+=("$core_port")
  CORE_LOGS+=("$core_log")
  CORE_SMOKE_ENVS+=("$smoke_env")

  echo "starting Gantry core[$idx] (:${core_port}) -> $core_log"
  (
    cd "$ROOT"
    exec env \
      -u ANTHROPIC_API_KEY \
      -u ANTHROPIC_AUTH_TOKEN \
      -u ANTHROPIC_BASE_URL \
      -u CLAUDE_CODE_OAUTH_TOKEN \
      -u OPENAI_API_KEY \
      GANTRY_FLOW_LOG=1 \
      GANTRY_OUTBOUND_DRYRUN=1 \
      GANTRY_CONTROL_PORT="$core_port" \
      GANTRY_DEV_LOG="$core_log" \
      GANTRY_IPC_SOCKET_PATH="$core_ipc_socket" \
      GANTRY_CONTROL_API_KEYS_JSON="$control_api_keys_json" \
      GANTRY_TEST_OPERATOR_PHONE="$OPERATOR" \
      GANTRY_TEST_CALLER_IDENTITY_PHONE="$CALLER_IDENTITY_PHONE" \
      node --enable-source-maps --import tsx "$ROOT/apps/core/src/index.ts"
  ) >"$core_log" 2>&1 &
  CORE_PIDS+=("$!")
done

echo "waiting for health..."
for _ in $(seq 1 60); do
  sleep 1
  shopify=$(curl -s --max-time 3 "$SHOPIFY_HEALTH_URL" 2>/dev/null || true)
  crm=$(curl -s --max-time 3 "$CRM_HEALTH_URL" 2>/dev/null || true)
  core_ready=1
  core_codes=()
  for core_port in "${CORE_PORTS[@]}"; do
    core=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${core_port}/" 2>/dev/null || true)
    core_codes+=("$core")
    if [ -z "$core" ] || [ "$core" = "000" ]; then
      core_ready=0
    fi
  done

  if echo "$shopify" | grep -q '"ok":true' &&
    echo "$crm" | grep -q '"ok":true' &&
    [ "$core_ready" -eq 1 ]; then
    echo "READY core_ports=${CORE_PORTS[*]} core_codes=${core_codes[*]} shopify=ok crm=ok"
    echo "Logs: core=${CORE_LOGS[*]} shopify=$SHOPIFY_DEV_LOG crm=$CRM_DEV_LOG"
    for smoke_env in "${CORE_SMOKE_ENVS[@]}"; do
      echo "Next: GANTRY_RUNTIME_SMOKE_ENV=$smoke_env npm run smoke:boondi-runtime"
    done
    wait "${CORE_PIDS[@]}" "$SHOPIFY_PID" "$CRM_PID"
    exit $?
  fi
done

echo "stack did not become healthy"
echo "Logs: core=$GANTRY_DEV_LOG shopify=$SHOPIFY_DEV_LOG crm=$CRM_DEV_LOG"
exit 1
