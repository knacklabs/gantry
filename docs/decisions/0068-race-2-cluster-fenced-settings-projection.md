---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-27
---

# Serialize settings-revision projection with a per-app advisory lease

## Context

Settings-revision *creation* is compare-and-swap protected, but *projection*
(applying a revision to the runtime) is not serialized across fleet processes.
`settings-revision-listener.ts` guards itself only with process-local
`appliedRevision`/`inFlight`; applying a revision runs a multi-step
save → reconcile → reload → alias-activate sequence with no revision fence, and
`restart-sync.ts` rolls back by unconditionally restoring `previousSettings` —
which can restore an OLDER revision over a newer applied one.

Exploration (decision inputs) established:

- **The fleet is genuinely multi-process.** Control, live-worker (≥2), and
  job-worker roles all reach `startFleetSubsystems()` and each starts a settings
  listener; all project the same app's revision into the shared Postgres
  desired-state repositories (decision 0027; `apps/core/src/app/index.ts`,
  `fleet-boot.ts`).
  Per-task settings *files* are container-local in production, but the
  desired-state *rows* are shared, so the interleaving is real. Local fleet
  rehearsal even shares the settings file.
- **A reusable lock primitive already exists**: `RuntimeLeasePort` /
  `tryAcquireRuntimeAdvisoryLease` (Postgres advisory lock in `runtime-store.ts`).
  No new lock table is needed.
- **Fence material exists**: the revision is monotonic per app
  (`(app_id, revision)` PK) and `getLatestSettingsRevision(appId)` is a cheap
  head read. No new counter needed.
- The dangerous unconditional rollback is confined to mutation/bootstrap paths
  that carry a local base (`restart-sync.ts` via CLI/control-API/`startup.ts`);
  the listener and normal revision-load paths pass no `previousSettings`.

## Decision

1. **Serialize projection per app under an advisory lease.** Every path that
   actually projects an app's settings acquires `settings-projector:${appId}`
   via the existing `RuntimeLeasePort`/`tryAcquireRuntimeAdvisoryLease` before
   applying, and releases it in `finally`. A small settings-specific wrapper adds
   only wait/retry, `finally` release, and the namespaced per-app key — the only
   new abstraction; no new lock table or lease system.

2. **Re-read the head under the lock.** After acquiring the lease, re-read
   `getLatestSettingsRevision(appId)` and apply the current head; skip a stale
   target (a revision already superseded by a newer one).

3. **Hold the lease across the whole apply.** The lease is held across the full
   save → reconcile → reload → alias-activate sequence, because `reconcile()`
   performs multiple shared Postgres writes that can interleave — a re-read-only
   fence closes just one check-then-act window and is insufficient.

4. **Failure handling depends on who is authoritative (two-way taxonomy).**
   - **Revision-authority projections** — anything projecting a committed fleet
     revision (fleet boot, the revision listener, `projectRequiredSettingsRevision`)
     — use **forward-correction, no rollback**. There is no safe local rollback
     base: the worker's `settings.yaml` is container-local while `reconcile()`
     mutates shared Postgres, so restoring the local file could move shared state
     *backward*. Projection is idempotent (each re-reads the head under the lease
     and applies the FULL current state), so a subsequent projection overwrites any
     partial state; on failure the projector logs and **retries / re-wakes**.
   - **File-authority imports** — where the caller's supplied settings ARE the
     source of truth (reload watcher, local/CLI workstation import) — roll back to
     the caller's **explicit `previousSettings`** (last-known-good) on failure.
     Never capture the current on-disk `settings.yaml` as the base: the reload
     watcher has already overwritten it with the failing candidate, so the on-disk
     value is the very config that just failed. These paths are single-authority
     (no shared-state regression concern), so restoring the explicit last-known-good
     is correct.

   Implemented via a `forwardCorrected` flag on `applyRuntimeSettingsDesiredState`:
   revision-authority callers pass `true` (no rollback); file-authority callers pass
   `false` and supply `previousSettings`. (Supersedes both the earlier
   head-comparison fence and the on-disk-snapshot-restore formulation, which
   autoreview showed unsafe.)

4b. **An unreadable superseding head is surfaced, not silently succeeded.** When
   a worker acquires the lease and finds the head requires a newer reader version
   than it supports, it does not report a successful projection: it propagates a
   held / incompatible-reader outcome (as the listener and boot paths do) so the
   caller keeps readiness red and does not continue on stale settings.

4c. **On a failed revision-authority projection, readiness goes red.** Because
   forward-correction leaves partial state in place, a failed apply marks settings
   **not-loaded** (readiness red) until a later full projection succeeds — so an
   incomplete projection is never advertised as ready.

## Scope split (RACE-2 core vs RACE-2b)

This decision covers the **core**: per-app advisory-lease **serialization** of
projection (including startup projecting an existing revision), stale-revision
skip, the reader-version fence, the failure taxonomy above, and
readiness-red-on-failure **on the listener path** (§4c). This closes the primary
out-of-order projection race and is strictly better than the pre-RACE-2 state
(which had no serialization at all).

**Deferred to RACE-2b (D-0013, its own decision) — the reliable-failure
contract:** two coupled pieces autoreview surfaced as the "applied-projection
contract," both distinct/deeper than the serialization core:
  1. A durable **"last-fully-applied revision" marker** so a synchronous required
     projection that fails **after** the listener already advanced its
     applied-revision counter is guaranteed to be re-projected (today such a rare
     interleaving can strand partial shared state until the next settings change).
  2. **Readiness-red completeness across all synchronous mutation projection
     paths** (control/CLI/watcher), not just the listener. Doing this in the core
     required threading a readiness signal through ~15 composition files and broke
     a layer budget — it belongs with the failure contract, not the serialization
     core.
These are tracked together so the serialization core can land now.

5. **Route initial fleet boot through the same coordinator**, since boot and
   synchronous mutation paths call the same shared apply function — listener-only
   locking would leave those unserialized.

## Consequences

- **Touched (production):** `settings-revision-listener.ts` (acquire/re-read/
  apply-or-skip/release), `fleet-boot.ts` (fence boot), `settings-import-service.ts`
  (mutation paths enter the coordinator; projection revision identity distinct
  from creation-time `expectedRevision`), `restart-sync.ts` (revision-aware
  rollback). Reuses `runtime-store.ts` lease + `getLatestSettingsRevision`; a thin
  `with...Lease` wrapper may live in `runtime-store.ts`/`runtime-lease.ts`.
- **No schema change**: monotonic revision + latest-head read already exist.
- **Tests:** listener two-projector ordering, "newer head exists → do not restore
  older", revision-aware mutation-failure rollback, and first direct coverage of
  `applyRuntimeSettingsDesiredState`'s rollback body.
- **Tradeoff:** projection is now serialized per app (a lease round-trip per
  apply). Acceptable — settings changes are rare and correctness dominates.
- Closes RACE-2. Sibling concurrency items RACE-3..9 tracked separately.
- Latent `desired-settings-writer.ts` no-store fallback (RACE-9) is out of scope
  here; tracked separately.
