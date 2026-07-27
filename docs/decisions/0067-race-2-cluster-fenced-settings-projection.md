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

4. **Rollback restores the pre-apply state captured under the lease.** On a
   failed projection, restore the actual on-disk state read immediately before
   the apply (captured while holding the lease), unconditionally — skipping only
   when there was no prior state (first boot). Do NOT fence rollback on the
   latest desired-revision head: revision *creation* is not under the projector
   lease, so a newer revision can be *created* (but not *projected*) while this
   process holds the lease projecting an older one — "head is newer" therefore
   does not mean "a newer revision was projected," and using it to skip rollback
   would abandon a partial failed projection. Because the whole apply+rollback
   runs under the lease, no concurrent projection can be clobbered; the next
   lease holder re-reads and projects the latest head. (Supersedes the earlier
   head-comparison formulation, which autoreview showed unsafe.)

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
