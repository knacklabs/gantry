#!/usr/bin/env bash
# Install or rotate the Shopify credentials in Gantry's credential broker.
#
# Why this exists:
#   The Shopify MCP server in ~/gantry/settings.yaml declares credential_refs
#   for SHOPIFY_PROD_SHOP_DOMAIN, SHOPIFY_PROD_CLIENT_ID, and
#   SHOPIFY_PROD_CLIENT_SECRET. When an agent (Boondi) gets the Shopify
#   capability materialized, Gantry asks the credential broker for those
#   values by name. If they're not registered, the agent run fails with:
#     "Gantry Secret required before this can run: SHOPIFY_PROD_SHOP_DOMAIN"
#
#   This script reads the values from ~/gantry/.env (where you keep them as
#   local dev secrets) and registers them in the broker, scoped so ONLY the
#   mcp:shopify-api MCP server can read them.
#
# When to run this:
#   - Initial Gantry setup on a new machine.
#   - You rotate the Shopify API token (custom app credentials change).
#   - Boondi is failing with "Gantry Secret required" errors for any of the
#     Shopify variables.
#
# Difference from rotate-anthropic-credential.sh:
#   That script uses OneCLI's MITM injection (type: anthropic, hostPattern:
#   api.anthropic.com) so OneCLI auto-attaches the bearer token to outgoing
#   Anthropic calls. Shopify works differently — the Shopify MCP server
#   makes its own outbound calls; OneCLI isn't on that wire. So we use the
#   higher-level `gantry secrets` CLI which registers NAMED secrets that
#   settings.yaml credential_refs can resolve. Same OneCLI storage,
#   different access pattern.
#
# Usage:
#   bash scripts/rotate-shopify-credentials.sh
#
# Env overrides:
#   GANTRY_REPO  default $HOME/Desktop/gantry
#   ENV_FILE     default $HOME/gantry/.env   (the runtime home .env)

set -euo pipefail

GANTRY_REPO="${GANTRY_REPO:-$HOME/Desktop/gantry}"
ENV_FILE="${ENV_FILE:-$HOME/gantry/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Env file not found at $ENV_FILE." >&2
  echo "Set ENV_FILE=/path/to/your/.env and rerun." >&2
  exit 1
fi

if [ ! -d "$GANTRY_REPO" ]; then
  echo "Gantry source repo not found at $GANTRY_REPO." >&2
  echo "Set GANTRY_REPO=/path/to/checkout and rerun." >&2
  exit 1
fi

# Source the env file so the CLI can read the values from process env.
# `set -a` exports everything sourced; `set +a` restores normal behavior.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Required secrets — credential_refs in settings.yaml asks for these by name.
REQUIRED_SECRETS=(
  SHOPIFY_PROD_SHOP_DOMAIN
  SHOPIFY_PROD_CLIENT_ID
  SHOPIFY_PROD_CLIENT_SECRET
)

# Optional secrets — register them if present in env. Useful when you flip
# SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY=true and need the HMAC signing key
# to resolve via the broker.
OPTIONAL_SECRETS=(
  SHOPIFY_MCP_IDENTITY_SECRET
)

ALLOW_SCOPE="mcp:shopify-api"

imported=0
skipped=0
missing=()

import_one() {
  local name="$1"
  local optional="$2"
  if [ -z "${!name:-}" ]; then
    if [ "$optional" = "1" ]; then
      echo "Skipping $name (not set in $ENV_FILE — optional)" >&2
      skipped=$((skipped + 1))
    else
      missing+=("$name")
    fi
    return
  fi
  echo "Importing $name (scoped to $ALLOW_SCOPE)..." >&2
  npx --prefix "$GANTRY_REPO" tsx \
    "$GANTRY_REPO/apps/core/src/cli/index.ts" \
    secrets import-env "$name" --allow "$ALLOW_SCOPE"
  imported=$((imported + 1))
}

for name in "${REQUIRED_SECRETS[@]}"; do
  import_one "$name" 0
done

for name in "${OPTIONAL_SECRETS[@]}"; do
  import_one "$name" 1
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "" >&2
  echo "ERROR: The following REQUIRED secrets are not set in $ENV_FILE:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  echo "" >&2
  echo "Add them to $ENV_FILE and rerun this script." >&2
  exit 1
fi

cat <<EOF >&2

Done. Imported $imported secret(s), skipped $skipped optional.

Verify with:
  npx --prefix $GANTRY_REPO tsx $GANTRY_REPO/apps/core/src/cli/index.ts secrets list

Then either let the running Gantry pick them up on the next message
(it retries on backoff), or restart \`npm run dev\` to refresh immediately.
EOF
