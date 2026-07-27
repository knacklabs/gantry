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

4. **Forward-correction on failure — no snapshot rollback.** A partially failed
   projection is NOT undone. There is no safe local rollback base: the worker's
   `settings.yaml` is container-local while `reconcile()` mutates shared Postgres
   desired-state, so a lagging worker's local file can be older than the shared
   repositories and restoring it would move shared state *backward*. Instead,
   projection is idempotent and authoritative: each projection re-reads the head
   under the lease and applies the FULL current state, so a subsequent projection
   overwrites any partial state with a complete, current one. On failure the
   projector logs and **retries / re-wakes** (rather than restoring), so a
   transient failure self-heals forward and does not linger. (Supersedes both the
   earlier head-comparison fence and the local-snapshot-restore formulation, which
   autoreview showed unsafe against shared state; a precise applied-projection
   rollback contract, if ever needed, is a separate decision.)

4b. **An unreadable superseding head is surfaced, not silently succeeded.** When
   a worker acquires the lease and finds the head requires a newer reader version
   than it supports, it does not report a successful projection: it propagates a
   held / incompatible-reader outcome (as the listener and boot paths do) so the
   caller keeps readiness red and does not continue on stale settings.

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
