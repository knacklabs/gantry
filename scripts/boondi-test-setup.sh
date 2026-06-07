#!/usr/bin/env bash
# Bring up the local Gantry dev stack in TEST mode for the Boondi regression.
# TEST ONLY — sets dry-run + the test operator set; never run this as production.
#
#   core       :4710  GANTRY_FLOW_LOG=1 (the runner parses it), GANTRY_OUTBOUND_DRYRUN=1
#                     (replies persist, sends go only to listed test numbers),
#                     GANTRY_TEST_OPERATOR_PHONE=<all test phones>,
#                     GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633 (Shopify "self"),
#                     stdout tee'd to $GANTRY_DEV_LOG (default /tmp/gantry-dev.log).
#   boondi-crm :8082  short digest-watcher poll so the crm group is fast.
#   shopify    :8081  must already be up (this script only warns if it isn't).
#
# Then run:  node scripts/boondi-regression.mjs   (and scripts/boondi-isolation.mjs)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_LOG=${GANTRY_DEV_LOG:-/tmp/gantry-dev.log}
CRM_LOG=${CRM_DEV_LOG:-/tmp/mcp-crm-dev.log}
STRIP="-u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_OAUTH_TOKEN"

OPERATOR=$(node -e "import('$ROOT/scripts/lib/phones.mjs').then(m=>process.stdout.write(m.OPERATOR_LIST))") || {
  echo "could not read OPERATOR_LIST from lib/phones.mjs"; exit 1; }
echo "test operator phones: $OPERATOR"

echo "stopping existing core + boondi-crm…"
pkill -f "apps/core/src/index.ts" 2>/dev/null || true
pkill -f "mcp-crm/src/index.ts" 2>/dev/null || true
sleep 2

if ! curl -s --max-time 3 http://127.0.0.1:8081/healthz 2>/dev/null | grep -q '"ok":true'; then
  echo "⚠️  shopify MCP (:8081) is not up — start it before the shopify group will pass."
fi

echo "starting boondi-crm (:8082, 10s watcher poll) → $CRM_LOG"
( cd "$ROOT" && env $STRIP BOONDI_CRM_RECONCILE_INTERVAL_MS=10000 \
    node --enable-source-maps --import tsx "$ROOT/packages/mcp-crm/src/index.ts" > "$CRM_LOG" 2>&1 & )

echo "starting core (:4710, flow-log + dry-run + test operators) → $DEV_LOG"
( cd "$ROOT" && env $STRIP GANTRY_FLOW_LOG=1 GANTRY_OUTBOUND_DRYRUN=1 \
    GANTRY_TEST_OPERATOR_PHONE="$OPERATOR" GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633 \
    node --enable-source-maps --import tsx "$ROOT/apps/core/src/index.ts" > "$DEV_LOG" 2>&1 & )

echo "waiting for health…"
for _ in $(seq 1 30); do
  sleep 2
  crm=$(curl -s --max-time 3 http://127.0.0.1:8082/healthz 2>/dev/null || true)
  core=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:4710/ 2>/dev/null || true)
  if echo "$crm" | grep -q '"ok":true' && [ -n "$core" ] && [ "$core" != "000" ]; then
    echo "READY — core(:4710 http=$core) crm(:8082 ok). Flow log: $DEV_LOG"
    echo "Next: node scripts/boondi-regression.mjs   (then node scripts/boondi-isolation.mjs)"
    exit 0
  fi
done
echo "stack did not become healthy; check $DEV_LOG and $CRM_LOG"
exit 1
