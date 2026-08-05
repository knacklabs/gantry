---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-05
stories: [SCHED-3]
---

# Job Definition Revision Fencing

## Context

Job finalization computes status and next_run from the job object loaded
BEFORE execution. The terminal write is fenced against the run lease but not
the definition: a human pause, schedule change, or requirement edit during a
long run is silently overwritten — the finalizer can reactivate a paused job
or write a next_run derived from a superseded schedule. The jobs schema has
no definition version to fence on.

## Decision

Jobs gain a definition_revision, incremented on every operator-meaningful
change (prompt, model, schedule, target, notification routes, requirements,
timeout/retry). Runs record the revision they claimed. The terminal
transaction reloads the job: on an unchanged revision it finalizes normally;
on a changed revision it preserves the operator-owned definition and desired
status, updates only run-owned state (lease, last-run result/failure), and
recomputes readiness and next_run from the LATEST definition through one
canonical reconciler. A finalizer never blindly reactivates a job after a
concurrent pause or edit.

## Consequences

- One schema migration (revision column) and a revision-aware terminal write.
- Status/next-run computation centralizes in a single reconciler instead of
  per-call-site derivation from stale snapshots.
- Concurrent human control actions become durable — pause during a run stays
  paused; new schedules produce new next_runs. Regression-tested.
