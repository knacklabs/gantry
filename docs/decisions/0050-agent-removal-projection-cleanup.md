---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-25
---

# Agent Removal Projection Cleanup

## Context
<!-- Why this decision was needed; the forces at play. -->

Removing an agent from desired state (`gantry agent remove`, PR #288) advances
the settings revision and drops the agent, but its projected `gantry.agents`
row survives with `status: active` (#289). Desired-state reconciliation only
disables absent agents when `desired_state.authoritative` is true
(`apps/core/src/config/settings/desired-state-service.ts:330`), and live config
leaves that false — so a removed agent's row is neither recreated (good, #288
holds) nor cleaned. Three options were on the table (see #289). Accepted
decision **0007** (`docs/decisions/0007-settings-runtime-truth.md:55`) already
fixes that destructive reconciliation happens **only** when
`desired_state.authoritative: true`, to protect live rows from a partial or
transient settings load. There is no hard-delete primitive for an agent row;
reconcile models removal as `disableAgent` (soft).

## Decision
<!-- What was decided, in one or two sentences. -->

The CLI agent-removal path cleans its own projection: after a successful
`pruneDesiredStateAgent` whose settings write actually persisted a revision
(`reconciled: true`), it disables the projected `gantry.agents` row via the
existing `repositories.agents.disableAgent` (reached through the CLI's existing
`withRuntimeStorage()` helper) — the same primitive authoritative reconcile
uses. We do **not** flip the reconcile gate (that would contradict 0007) and we
do **not** add a hard delete.

## Consequences
<!-- What follows: tradeoffs accepted, doors closed, work implied. -->

- Explicit operator removal — the case 0007's gate is *not* guarding — becomes
  the trigger for projection cleanup; reconcile semantics and decision 0007 are
  untouched.
- Removal in file-only degraded mode (`reconciled: false`, no storage provider)
  skips the projection step and reports the partial outcome rather than
  disabling a row while the authority still declares the agent.
- Rows are disabled, not deleted — history/audit preserved, consistent with the
  only existing primitive; no schema migration.
- The ~14 pre-existing inert `codex_test_*` orphan rows need a one-off
  idempotent sweep (they predate this change); keyed off current desired-state
  settings so it can never disable a still-declared agent.
- A control-API `DELETE /v1/agents` remains out of scope; the CLI is the only
  remover today.
