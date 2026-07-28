---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-27
---

# Own browser profiles with a durable advisory lease, not a hand-rolled lockfile

## Context

Two races in the browser profile lock (RACE-4 of the concurrency hardening
initiative):

1. **Stale-lock reclamation cannot be made safe with lockfile primitives.**
   `apps/core/src/runtime/browser-profiles.ts` acquires with
   `openSync(..., 'wx')` and, on `EEXIST`, decides the existing lock is stale
   (dead pid, or pid-less and older than `PROFILE_LOCK_STALE_MS`) and removes the
   pathname so it can retry. Every variant of that removal is ABA-vulnerable, and
   three successive attempts each only *moved* the window (autoreview found a
   distinct real interleaving each time):
   - *read → check → `rmSync`*: a contender can delete and recreate the lock
     between the check and the unlink, so the unlink kills the new owner's lock.
   - *`renameSync` to claim, then delete*: `rename` is atomic on the **pathname**,
     not conditional on the **instance**; a contender can replace the stale lock
     with a live one, which the rename then claims and deletes.
   - *claim by rename → verify token → restore with `linkSync` on mismatch*:
     while the mis-claimed lock sits at our private path, `lockPath` is briefly
     **absent**, so a third contender can acquire; the restore then fails `EEXIST`
     and the live owner's lock is discarded → two live owners.

   The root cause is structural: **the filesystem offers no conditional
   (compare-and-swap) operation on a pathname**, so exclusivity built from
   create/rename/link/unlink sequences always leaves a window. Continuing to
   hand-roll it is not viable.

2. **`closeBrowser` released the lock before clearing shared state.** It called
   `session.lock.release()` and only afterward `sessions.delete`,
   `clearBrowserSessionRecord`, and `updateProfileMetadata`, so a new owner could
   acquire in that window and have its fresh session record/metadata clobbered by
   the old closer.

Node has **no** native `flock` (`fs.flock`/`LOCK_EX` are undefined) and the repo
carries no locking dependency, so a kernel advisory lock is not available without
adding a native module. The repo *does* already have a durable advisory-lease
primitive — `tryAcquireRuntimeAdvisoryLease` / `RuntimeLeasePort` (Postgres
advisory lock), the same primitive RACE-2 used for settings projection.

## Decision

1. **Own a browser profile with the existing durable advisory lease.** Replace the
   hand-rolled lockfile protocol with `RuntimeLeasePort.tryAcquire` on a
   profile-scoped key (e.g. `browser-profile:<profileName>`), injected as a
   dependency (never importing the Postgres adapter from `runtime/`). Exclusivity
   is enforced by the lock server, and the lease is **released automatically when
   the holder's connection drops** — so a dead holder needs no reclamation at all.
   **Delete the staleness heuristics, the pid-liveness check, the reclaim/restore
   protocol, and `PROFILE_LOCK_STALE_MS`**: the entire ABA class disappears rather
   than being patched. This is a *reduction* in code, not an addition.

   The lock file may remain only as non-authoritative metadata (heartbeat/`last_used`
   diagnostics) if something already reads it; it must no longer decide ownership.

2. **Release the lease last, guaranteed.** In `closeBrowser`, all shared-state
   cleanup — `sessions.delete`, `clearBrowserSessionRecord`,
   `updateProfileMetadata` — runs **before** the release, with the release in a
   `finally` so it always runs even if cleanup throws (otherwise the lease leaks:
   `sessions.delete` has already dropped the only reference that could release it).
   This half was reviewed clean under the lockfile design and carries over unchanged.

3. **Detect lease loss and fail closed.** The loss handler is registered
   *synchronously* at acquire (registering after an `await` can miss a loss that
   never replays); the lock exposes `isValid()`/`onLost`; on loss the worker stops
   driving the browser, performs no ownership-scoped shared-state cleanup (a
   successor may already own it), and never reports an unconfirmed teardown as
   success.

## Scope split (RACE-4 core vs RACE-4b)

This decision covers the **core**: lease-based ownership replacing the lockfile
(which *removes the ABA class outright* — confirmed by review), release-last with
`finally`, and loss **detection** with fail-closed behavior.

**Deferred to RACE-4b (D-0013, D-0014):** loss *detection* is not the same as safe
*handoff*. A successor can acquire the freed lease while the previous Chrome is
still shutting down, and a stale owner's in-flight snapshot upsert can commit after
handoff. Closing those needs a **lease-generation fencing contract** — the new owner
must quarantine/confirm-stop the previous generation, and snapshot publication needs
a generation CAS (or must share the advisory-lock session) — plus generation-scoped
snapshot suppression instead of a process-global per-profile marker. That is a
deeper design than the ownership migration, shares its fencing-token shape with
RACE-5, and is tracked separately so the core can land.

## Consequences

- **Touched:** `apps/core/src/runtime/browser-profiles.ts` (lease-based acquire,
  staleness/reclaim logic removed), `apps/core/src/runtime/browser-capability.ts`
  (cleanup-before-release in `finally`), the composition sites that must now inject
  the lease port, and their unit tests.
- **Behavior change:** profile ownership now requires the lock server to be
  reachable. Acquire waits with bounded retry and fails closed if the lease cannot
  be taken — a browser launch will fail rather than risk two owners of one profile.
  That is the correct trade for a resource whose double-use corrupts profile data.
- **Scope risk accepted:** injecting the lease port into the runtime browser path
  may ripple through wiring files (RACE-2's equivalent threading touched ~15). If
  that ripple breaks a layer budget or balloons, land the `closeBrowser` `finally`
  fix and split the lease migration rather than forcing it.
- Bounded: does not address browser per-turn *ownership scope* (RACE-3, separate)
  or the snapshot-quiescence lock (already handled). Closes RACE-4.
- Supersedes the earlier "token-guard the reclamation" formulation in this record;
  the three failed variants are kept in Context as the evidence for why a lockfile
  protocol was abandoned.
