---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-27
---

# Token-guard browser stale-lock reclamation and release the lock last

## Context

Two ABA/ordering races in the browser profile lock (RACE-4 of the concurrency
hardening initiative):

1. **Stale-lock reclamation is not atomic.** `apps/core/src/runtime/browser-profiles.ts`
   (~:314-324) handles an `EEXIST` on `openSync(..., 'wx')` by reading the
   existing lock, deciding it is stale (dead pid, or pid-less and older than
   `PROFILE_LOCK_STALE_MS`), and then `fs.rmSync(lockPath, { force: true })`.
   That removal is **not** guarded by the instance it observed: between
   `readLockFile` and `rmSync`, another process can reclaim the stale lock
   (remove it and create a fresh one with a new token). This `rmSync` then
   deletes the **new** owner's lock → two processes believe they own the
   profile. By contrast `release()` (~:298-303) already does a token-guarded
   delete (`if (current.token === token) rmSync`).

2. **`closeBrowser` releases the lock before clearing shared state.**
   `apps/core/src/runtime/browser-capability.ts` (~:663-669) calls `session.lock.release()`
   and only *afterward* `sessions.delete`, `clearBrowserSessionRecord`, and
   `updateProfileMetadata`. A new owner can acquire the lock in that window and
   write a fresh session record + metadata, which the old closer then clobbers
   → deleted session record / stale CDP metadata for the new owner.

## Decision

1. **Token-guarded (compare-and-delete) stale reclamation.** Before removing a
   lock it judged stale, the reclaim path re-reads the lock and removes it only
   if it is still the **same** instance it observed (same token — or same
   pid+mtime for a pid-less lock). If it changed, another process already
   reclaimed it: do not remove, just retry the acquire loop. This mirrors the
   token guard `release()` already uses, extended to reclamation.

2. **Release the lock last.** In `closeBrowser`, perform all shared-state
   cleanup — `sessions.delete`, `clearBrowserSessionRecord`,
   `updateProfileMetadata` — **before** `session.lock.release()`. Release is the
   final operation, so no new owner can acquire the lock until this closer has
   finished touching shared state. (The non-hot-path branch already does this;
   this aligns the hot path.)

## Consequences

- **Touched:** `apps/core/src/runtime/browser-profiles.ts` (stale-reclaim guard),
  `apps/core/src/runtime/browser-capability.ts` (cleanup-before-release ordering), and their
  unit tests.
- No new lock format or dependency; reuses the existing token in the lock file.
- **Tradeoff:** an extra `readLockFile` in the reclaim path (once per stale
  observation) — negligible; correctness dominates a rare takeover path.
- Bounded: does not address browser per-turn *ownership* scope (RACE-3, separate)
  or the snapshot-quiescence lock (already handled). Closes RACE-4.
- Test note: `browser-capability.test.ts` deadline/ordering tests may need
  `await vi.waitFor(...)` around async spawn hops (pre-existing pattern in that
  suite); keep the existing `describe.each`/lock tests green as the guard.
