#!/usr/bin/env bash
# Local pre-merge smoke test: trigger a real agent job via the gantry CLI and
# assert it completes. Proves the packaged runtime can execute a full agent turn
# (model + tools + MCP + capabilities + delivery) end to end.
#
# Usage:
#   scripts/agent-job-smoke.sh [JOB_ID] [--timeout-sec N]
# Defaults to the KnackLabs lead-maintenance job. Requires a running local
# runtime (`gantry status`) and the CLI on PATH.
#
# Exit 0 = job reached health "completed"; non-zero = failed / timed out / not
# runnable. Side effects: runs the real job (model tokens; the job posts its
# status line to its bound chat). Not hermetic — see docs/architecture/
# agent-e2e-ci-merge-gate-goal-prompt.md for the hermetic CI version.
set -euo pipefail

JOB_ID="${1:-job-knacklabs-lead-maintenance-43527c192a6e}"
TIMEOUT_SEC=900
[ "${2:-}" = "--timeout-sec" ] && TIMEOUT_SEC="${3:-900}"

health_of() {
  # Extract the Health: value from the CLI's box-rendered output, tolerating the
  # unicode frame characters.
  gantry jobs show "$JOB_ID" 2>&1 \
    | grep -a 'Health:' | head -1 \
    | sed 's/[^A-Za-z: ]//g' | awk -F'Health:' '{print $2}' | tr -d ' '
}

echo "[smoke] runtime status check…"
gantry status >/dev/null 2>&1 || { echo "[smoke] FAIL: local runtime not reachable (gantry status)"; exit 2; }

echo "[smoke] triggering $JOB_ID …"
gantry jobs trigger "$JOB_ID" >/dev/null 2>&1 || { echo "[smoke] FAIL: could not trigger job (is it active?)"; exit 2; }

echo "[smoke] waiting for terminal health (timeout ${TIMEOUT_SEC}s)…"
deadline=$(( $(date +%s) + TIMEOUT_SEC ))
# Give the scheduler a moment to pick up the trigger and flip to running.
sleep 10
while [ "$(date +%s)" -lt "$deadline" ]; do
  h="$(health_of || true)"
  case "$h" in
    running|"") sleep 15 ;;
    completed)  echo "[smoke] PASS: job completed"; exit 0 ;;
    *)          echo "[smoke] FAIL: terminal health = '$h'"; gantry jobs show "$JOB_ID" 2>&1 | grep -aiE 'Health|Next action|Recovery' | head; exit 1 ;;
  esac
done
echo "[smoke] FAIL: still not terminal after ${TIMEOUT_SEC}s"
exit 1
