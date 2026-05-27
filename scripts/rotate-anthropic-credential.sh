#!/usr/bin/env bash
# Install or rotate the Anthropic credential in OneCLI.
#
# Why this exists:
#   Gantry agents reach api.anthropic.com through the OneCLI MITM proxy.
#   OneCLI injects the real credential as an HTTP header on outgoing requests,
#   based on a stored secret with `type: "anthropic"`. This script installs
#   that secret (or replaces its value), and is the right action to take when:
#     - You're setting up Gantry on a new machine (initial install).
#     - Your `claude setup-token` token is approaching its 1-year expiry.
#     - Boondi is returning 401 and `docker logs gantry-onecli` shows
#       `status=401 injections_applied=1` (token is reaching Anthropic but is
#       rejected — usually expired/revoked).
#
# What this script does NOT do:
#   - It does not refresh interactive `claude /login` OAuth tokens. Those
#     have a single-use refresh chain that's not safe for unattended use.
#     Use `claude setup-token` instead (this script will tell you to).
#
# Usage:
#   bash scripts/rotate-anthropic-credential.sh
#
# Env overrides:
#   ONECLI_URL          default http://127.0.0.1:10254
#   ANTHROPIC_TOKEN     skip the prompt and read the token from this var
#                       (useful when piping from `claude setup-token`)

set -euo pipefail

ONECLI_URL="${ONECLI_URL:-http://127.0.0.1:10254}"

if [ -n "${ANTHROPIC_TOKEN:-}" ]; then
  TOKEN="$ANTHROPIC_TOKEN"
else
  cat <<'EOF' >&2

To rotate Gantry's Anthropic credential you need a long-lived token.

  • Subscription (Pro/Max/Team/Enterprise): run `claude setup-token` in a
    separate terminal. It will open a browser, then PRINT THE TOKEN ONCE to
    the terminal. Copy that token (starts with `sk-ant-oat01-...`).

  • Direct API billing: paste an `sk-ant-api...` key from
    https://platform.claude.com/settings/keys instead.

EOF
  read -r -s -p "Paste the token (input hidden): " TOKEN
  echo >&2
fi

if [ -z "$TOKEN" ]; then
  echo "No token provided. Aborting." >&2
  exit 1
fi

# Sanity check: token shape.
case "$TOKEN" in
  sk-ant-oat01-*) MODE="oauth (subscription, 1-year setup-token)" ;;
  sk-ant-api03-*) MODE="api-key (console)" ;;
  *) echo "Token does not match known Anthropic prefixes. Aborting." >&2; exit 1 ;;
esac
echo "Detected: $MODE" >&2

# Confirm OneCLI is reachable.
if ! curl -fsS "$ONECLI_URL/api/health" >/dev/null; then
  echo "OneCLI is not reachable at $ONECLI_URL." >&2
  echo "Start it with: docker compose --env-file ~/Desktop/gantry/.env up -d" >&2
  exit 1
fi

# Find an existing anthropic-type secret bound to api.anthropic.com.
SECRET_ID=$(curl -s "$ONECLI_URL/api/secrets" | python3 -c "
import sys, json
for s in json.load(sys.stdin):
    if s.get('type') == 'anthropic' and s.get('hostPattern') == 'api.anthropic.com':
        print(s['id']); break")

if [ -n "$SECRET_ID" ]; then
  echo "Updating existing anthropic secret ($SECRET_ID)..." >&2
  RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$ONECLI_URL/api/secrets/$SECRET_ID" \
    -H "Content-Type: application/json" \
    -d "{\"value\":\"$TOKEN\"}")
else
  echo "No anthropic secret found — creating one..." >&2
  RESP=$(curl -s -w "\n%{http_code}" -X POST "$ONECLI_URL/api/secrets" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"Anthropic (setup-token)\",
         \"type\":\"anthropic\",
         \"value\":\"$TOKEN\",
         \"hostPattern\":\"api.anthropic.com\",
         \"pathPattern\":\"/*\"}")
fi
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
if [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; then
  echo "OneCLI returned HTTP $CODE: $BODY" >&2
  exit 1
fi

cat <<EOF >&2

Done. Now restart Gantry so the credential broker picks up the new value:

  # Either Ctrl+C the running \`npm run dev\` and rerun it, or:
  # Stop & start through whatever supervises your gantry process.

Then send a test message (or replay a captured webhook) and verify in
\`/tmp/llm-debug.log\` that the result has \`is_error: false\` and
non-zero \`input_tokens\` / \`output_tokens\`.
EOF
