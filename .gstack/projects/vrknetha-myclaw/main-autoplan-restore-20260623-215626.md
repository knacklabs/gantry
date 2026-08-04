# /autoplan Restore Point
Captured: 2026-06-23 21:56:26 | Branch: main | Commit: 656927b9

## Re-run Instructions
1. Copy "Original Plan State" below back to your plan file
2. Invoke /autoplan

## Original Plan State

# Fleet Settings Persistence + Deployment-Safe Secrets

## Context

In ECS **fleet** mode the runtime boots by reading the latest row from the
Postgres `settings_revisions` table (`apps/core/src/app/bootstrap/fleet-boot.ts`
→ `prepareFleetSettings`), rendering it to an *ephemeral* local `settings.yaml`,
and reconciling it into normalized projection tables.

**Confirmed split-brain:** the settings *mutation* paths do **not** append a
`settings_revisions` row in fleet mode. They reconcile projection tables + write
the ephemeral `settings.yaml`, but never advance the durable revision. On ECS
redeploy (empty filesystem) the new task reads a **stale** revision and reverts
every provider/agent/binding/approver change made through the CLI or most
control-API routes.

[... full plan content preserved in the live plan file at
/Users/ravikiranvemula/.claude/plans/fleet-settings-persistence-vectorized-melody.md ...]
