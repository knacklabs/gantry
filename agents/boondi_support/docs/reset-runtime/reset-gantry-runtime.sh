#!/usr/bin/env bash
#
# reset-gantry-runtime.sh — create a brand-new Gantry runtime, preserving only
# the Claude OAuth credential.
#
# What it does (in order):
#   1. Extract the Anthropic Claude Code OAuth token from the LIVE database
#      (falls back to the macOS Keychain entry "gantry-anthropic-oauth").
#      Aborts BEFORE deleting anything if no valid token can be recovered.
#   2. Stop the gantry-postgres Docker container (so its data volume can be
#      deleted safely).
#   3. Delete everything under <runtime home> EXCEPT:
#         .env  .prettierignore  settings.example.yaml  settings.yaml  agents/
#      and, inside every agents/<agent>/ folder, delete only `.llm-runtime` and
#      `logs` (the symlinked SOUL.md/CLAUDE.md/commands/guardrails/skills/etc are
#      left untouched).
#   4. Bring the postgres container back up on the now-empty volume. The init
#      scripts in ops/postgres/init recreate the gantry_app role + schemas +
#      extensions automatically.
#   5. Re-store the Claude OAuth token into the fresh database (this also runs
#      the storage migrations), then verify it reads back.
#
# It intentionally does NOT start/stop the Gantry runtime service (launchd
# com.gantry) or run `gantry setup` — "nothing else", per the request. The only
# server it cycles is the Postgres container, which is unavoidable when wiping
# the database volume.
#
# Usage (from anywhere):
#   bash ops/reset-runtime/reset-gantry-runtime.sh            # interactive confirm
#   bash ops/reset-runtime/reset-gantry-runtime.sh --dry-run  # show plan, change nothing
#   bash ops/reset-runtime/reset-gantry-runtime.sh --yes      # skip the typed confirmation
#
set -euo pipefail

# ---- locations --------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_HOME="${GANTRY_HOME:-$HOME/gantry}"
COMPOSE_FILE="$REPO_DIR/docker-compose.yml"
PG_SERVICE="postgres"
PG_CONTAINER="gantry-postgres"
ENV_FILE="$RUNTIME_HOME/.env"

# Top-level entries to KEEP. Everything else under $RUNTIME_HOME is deleted.
KEEP=(".env" ".prettierignore" "settings.example.yaml" "settings.yaml" "agents")
# Inside each agents/<agent>/ folder, only these subpaths are deleted.
AGENT_WIPE=(".llm-runtime" "logs")

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m[reset]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[reset]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[reset]\033[0m %s\n' "$*" >&2; exit 1; }

# Per the "running Gantry from Claude Code" runbook: strip injected ANTHROPIC_*
# so the tsx helpers use only the runtime's own .env config.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
      ANTHROPIC_DEFAULT_HEADERS CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true

# ---- preflight --------------------------------------------------------------
[[ -d "$RUNTIME_HOME" ]] || die "Runtime home not found: $RUNTIME_HOME"
[[ -f "$ENV_FILE" ]]     || die "Missing $ENV_FILE (needed for GANTRY_DATABASE_URL / SECRET_ENCRYPTION_KEY)."
[[ -f "$COMPOSE_FILE" ]] || die "Missing compose file: $COMPOSE_FILE"
command -v docker >/dev/null || die "docker is not installed / not on PATH."
docker compose version >/dev/null 2>&1 || die "'docker compose' is unavailable."
command -v npx >/dev/null || die "npx is not installed / not on PATH."
# Never operate on a dangerous root.
case "$RUNTIME_HOME" in
  ""|"/"|"$HOME") die "Refusing to operate on RUNTIME_HOME='$RUNTIME_HOME'." ;;
esac

compose() { (cd "$REPO_DIR" && docker compose --env-file "$ENV_FILE" "$@"); }

# ---- compute deletion plan --------------------------------------------------
is_kept() { local b="$1" k; for k in "${KEEP[@]}"; do [[ "$b" == "$k" ]] && return 0; done; return 1; }

TOP_TARGETS=()
while IFS= read -r -d '' entry; do
  is_kept "$(basename "$entry")" && continue
  TOP_TARGETS+=("$entry")
done < <(find "$RUNTIME_HOME" -mindepth 1 -maxdepth 1 -print0)

AGENT_TARGETS=()
if [[ -d "$RUNTIME_HOME/agents" ]]; then
  while IFS= read -r -d '' agentdir; do
    for sub in "${AGENT_WIPE[@]}"; do
      [[ -e "$agentdir/$sub" || -L "$agentdir/$sub" ]] && AGENT_TARGETS+=("$agentdir/$sub")
    done
  done < <(find "$RUNTIME_HOME/agents" -mindepth 1 -maxdepth 1 -type d -print0)
fi

log "Runtime home : $RUNTIME_HOME"
log "Repo dir     : $REPO_DIR"
log "Keep         : ${KEEP[*]}"
echo
log "Will DELETE the following:"
[[ ${#TOP_TARGETS[@]} -gt 0 ]] && for t in "${TOP_TARGETS[@]}"; do printf '   - %s\n' "$t"; done
[[ ${#AGENT_TARGETS[@]} -gt 0 ]] && for t in "${AGENT_TARGETS[@]}"; do printf '   - %s\n' "$t"; done
[[ ${#TOP_TARGETS[@]} -eq 0 && ${#AGENT_TARGETS[@]} -eq 0 ]] && log "   (nothing matched)"
echo

# ---- step 1: recover the OAuth token (DB first, Keychain fallback) -----------
log "Recovering Claude OAuth token (before any deletion)..."
OAUTH_TOKEN=""
SOURCE=""

EXTRACT_OUT="$(cd "$REPO_DIR" && GANTRY_HOME="$RUNTIME_HOME" npx tsx ops/reset-runtime/extract-anthropic-token.ts 2>/tmp/gantry-extract.err)" || true
OAUTH_TOKEN="$(printf '%s' "$EXTRACT_OUT" | sed -n 's/.*__GANTRY_OAUTH_BEGIN__\(.*\)__GANTRY_OAUTH_END__.*/\1/p')"
[[ -n "$OAUTH_TOKEN" ]] && SOURCE="database"

if [[ -z "$OAUTH_TOKEN" ]] && command -v security >/dev/null 2>&1; then
  warn "Database extraction returned nothing; trying macOS Keychain (gantry-anthropic-oauth)..."
  [[ -s /tmp/gantry-extract.err ]] && sed 's/^/    db> /' /tmp/gantry-extract.err >&2 || true
  KC_DECODED="$(security find-generic-password -s gantry-anthropic-oauth -w 2>/dev/null | xxd -r -p 2>/dev/null || true)"
  OAUTH_TOKEN="$(printf '%s' "$KC_DECODED" | grep -oE 'sk-ant-oat01-[A-Za-z0-9_-]+' | head -n1 || true)"
  [[ -n "$OAUTH_TOKEN" ]] && SOURCE="keychain"
fi

if [[ -z "$OAUTH_TOKEN" || "$OAUTH_TOKEN" != sk-ant-oat01* ]]; then
  [[ -s /tmp/gantry-extract.err ]] && sed 's/^/    db> /' /tmp/gantry-extract.err >&2 || true
  die "Could not recover a valid Claude OAuth token. ABORTING before deleting anything."
fi
rm -f /tmp/gantry-extract.err 2>/dev/null || true

TOKEN_FP="$(printf '%s' "$OAUTH_TOKEN" | shasum -a 256 | cut -c1-16)"
log "Recovered token from ${SOURCE}: format=sk-ant-oat01 length=${#OAUTH_TOKEN} sha256=${TOKEN_FP}"

# ---- dry run stops here -----------------------------------------------------
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  log "DRY RUN — no container was stopped, nothing was deleted, no credential was written."
  log "Re-run without --dry-run to execute."
  exit 0
fi

# ---- confirm ----------------------------------------------------------------
if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  warn "This ERASES the entire Gantry database and the runtime dirs listed above. This cannot be undone."
  read -r -p "Type WIPE to proceed: " CONFIRM
  [[ "$CONFIRM" == "WIPE" ]] || die "Confirmation not received; aborting."
fi

# ---- step 2: stop postgres --------------------------------------------------
log "Stopping $PG_CONTAINER ..."
compose stop "$PG_SERVICE"
# Make sure it is really stopped before touching its data volume.
if [[ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || echo false)" == "true" ]]; then
  die "$PG_CONTAINER is still running after 'compose stop'; aborting to avoid corrupting a live database."
fi

# ---- step 3: delete ---------------------------------------------------------
log "Deleting runtime files/folders ..."
delete_target() {
  local t="$1"
  case "$t" in
    "$RUNTIME_HOME"/*) ;;                       # must live under runtime home
    *) warn "skip (outside runtime home): $t"; return 0 ;;
  esac
  rm -rf -- "$t"
  printf '   deleted %s\n' "$t"
}
[[ ${#TOP_TARGETS[@]} -gt 0 ]] && for t in "${TOP_TARGETS[@]}"; do delete_target "$t"; done
[[ ${#AGENT_TARGETS[@]} -gt 0 ]] && for t in "${AGENT_TARGETS[@]}"; do delete_target "$t"; done

# ---- step 4: bring postgres back up fresh -----------------------------------
log "Starting a fresh $PG_CONTAINER (empty volume -> auto re-init) ..."
compose up -d "$PG_SERVICE"

log "Waiting for Postgres to become healthy ..."
deadline=$(( SECONDS + 120 ))
until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || echo starting)" == "healthy" ]]; do
  [[ $SECONDS -ge $deadline ]] && die "Postgres did not become healthy within 120s. Check: docker logs $PG_CONTAINER"
  sleep 2
done
log "Postgres is healthy."

# ---- step 5: re-store the token, then verify --------------------------------
log "Re-storing the Claude OAuth credential into the fresh database ..."
(cd "$REPO_DIR" && GANTRY_HOME="$RUNTIME_HOME" GANTRY_RESET_OAUTH_TOKEN="$OAUTH_TOKEN" \
  npx tsx ops/reset-runtime/store-anthropic-token.ts)
unset OAUTH_TOKEN GANTRY_RESET_OAUTH_TOKEN

log "Verifying the credential reads back ..."
(cd "$REPO_DIR" && GANTRY_HOME="$RUNTIME_HOME" npx tsx ops/reset-runtime/extract-anthropic-token.ts --check)

echo
log "Done. Fresh runtime + fresh database, Claude OAuth credential restored."
log "Note: the Gantry runtime service was NOT started (per request). Start it when you're ready."
