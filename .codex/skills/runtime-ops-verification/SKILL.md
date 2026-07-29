---
name: runtime-ops-verification
description: Guides Gantry local runtime verification, build/restart/status workflows, launchd service checks, disposable Postgres testing, and release handoff. Use when asked to build, restart, validate runtime health, verify DB-backed behavior, or confirm what is actually running.
---

# Runtime Ops Verification

Use this skill for local service checks, runtime verification, and release
handoff steps that must prove the built checkout is what actually runs.

## Required Workflow

1. Read `docs/architecture/current-verification-commands.md` and run `python3 .agents/scripts/forge.py next` to confirm the current phase contract.
2. Build first, restart second, verify third. Do not restart after a failed build.
3. Use the current local launchd label `com.gantry` for service workflows.
4. Prefer the repo-built CLI entrypoint when a global shim is missing, stale, or permission-blocked.
5. Before validating `~/gantry`, build/restart from this checkout and treat older generated logs or state as stale.
6. For Postgres-backed verification, use a disposable Docker Postgres with required extensions, set `GANTRY_TEST_DATABASE_URL`, run the focused check, then stop/remove the container.
7. Report exact commands, status evidence, and any skipped checks.

## Evidence To Provide

- Build command result before any restart.
- Restart/status command and target service label.
- Runtime health evidence from the built checkout.
- Disposable Postgres command and cleanup evidence for DB-backed changes.
