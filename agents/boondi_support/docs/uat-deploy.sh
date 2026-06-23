#!/usr/bin/env bash
#
# Rolling UAT deploy. Pulls the latest UAT branch, rebuilds, and gracefully
# reloads the stack via pm2. Safe to run on a timer (poll) or from a push hook.
#
#   - `set -e` aborts BEFORE the reload if the build fails, so a broken commit
#     never replaces the code that is currently serving traffic.
#   - `pm2 reload` is graceful: it brings the new process up and drains the old
#     one, rather than a hard stop/start. core gets a long kill_timeout so it can
#     drain in-flight conversations (lease-draining on shutdown).
#
# Override any path via env (UAT_APP_DIR, UAT_ADMIN_DIR, UAT_ECOSYSTEM, UAT_BRANCH).
#
set -euo pipefail

APP_DIR="${UAT_APP_DIR:-/opt/boondi/Agent.Gantry}"   # gantry repo clone
ADMIN_DIR="${UAT_ADMIN_DIR:-/opt/boondi/admin}"        # admin dashboard clone
ECOSYSTEM="${UAT_ECOSYSTEM:-/opt/boondi/ecosystem.config.js}"
BRANCH="${UAT_BRANCH:-UAT}"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

cd "$APP_DIR"
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

# Nothing new -> exit quietly (so a 60s poll is almost always a no-op).
[ "$LOCAL" = "$REMOTE" ] && exit 0

log "deploy $APP_DIR: $LOCAL -> $REMOTE   (rollback: git reset --hard $LOCAL && npm run build && pm2 reload $ECOSYSTEM)"
git reset --hard "origin/$BRANCH"

# Build to dist BEFORE reloading. A failure here exits via set -e with the old
# processes untouched (they keep running their already-loaded code).
npm ci
npm run build
npm run build --workspace @gantry/mcp-crm
npm run build --workspace @gantry/mcp-shopify

# Admin dashboard lives in its own repo (same branch name). Skip if absent.
if [ -d "$ADMIN_DIR/.git" ]; then
  log "deploy admin: $ADMIN_DIR"
  git -C "$ADMIN_DIR" fetch --quiet origin "$BRANCH"
  git -C "$ADMIN_DIR" reset --hard "origin/$BRANCH"
  ( cd "$ADMIN_DIR" && npm ci && npm run build )
fi

# Graceful rolling reload of the whole stack.
pm2 reload "$ECOSYSTEM" --update-env

log "deploy OK -> $REMOTE"
