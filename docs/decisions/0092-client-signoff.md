---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-30
---

# RACE-3 Client Signoff

## Context

Browser profiles are keyed on `(agent, conversation)` only
(`shared/browser-profile-scope.ts:19-29`). This runtime has 3 telegram, 3 slack and
16 app provider accounts, so two accounts operating in one conversation share a single
Chrome profile — and therefore its cookies and logged-in sessions.

Separately, the "browser was used this turn" flag is a bare `Set<profileName>` that the
finalizer read-and-clears. Concurrent threads of one conversation share a profile name, so
a sibling thread's finalize consumes another turn's flag and that turn's browser work is
never snapshotted. FENCE-1's advisory lock prevents corruption here, but not the loss.

RACE-3 was picked ahead of RACE-7 and FENCE-2 on exposure: this runtime is single-worker
(271 worker rows, 1 healthy), so those two are unreachable in production today while this
is reachable now.

## Decision

Ravi approved, after a `/grill-me` interrogation on 2026-07-30:

1. **Add the provider-account axis only.** No thread axis — threads of one conversation
   should keep sharing a login, and per-thread Chrome profiles would mean re-authenticating
   in every thread.
2. **Resolve the account server-side from the durable route.** It must not arrive from the
   runner: the IPC handler re-derives the profile name precisely so a compromised runner
   cannot name another conversation's profile.
3. **An unresolvable route gets an explicit sentinel segment**, isolated from every real
   account, and the sentinel is rejected as a literal account id so it cannot be forced to
   collide. Browsing keeps working rather than failing closed.
4. **The default profile (no conversation) stays shared across accounts**, recorded as a
   deliberate boundary: it is the no-conversation workspace CLI and manual use expect to be
   one stable browser.
5. **Attribute activity per turn**, keyed on `(profileName, queueKey)`, so a finalize clears
   only its own thread's flag.
6. **The account axis is a required parameter**, so `tsc` forces all seven derivation sites
   to be considered rather than silently omitting it.

## Consequences

- **Upgrade constraint, not a general no-op.** Adding the account to the hash changes the
  profile name for EVERY conversation-scoped browser, including conversations served by a
  single account. Any deployment that already has profiles will find those browsers logged
  out, with prior cookies and snapshots stranded under the old `(agent, conversation)` name.

  This was verified as a no-op for THIS runtime at plan time and again at implementation:
  zero profiles on disk, zero `gantry.browser_profiles` rows. That check is
  deployment-specific and does not make the upgrade safe generally.

  Accepted deliberately rather than adding a compatibility lookup, because a fallback to the
  old name is exactly the legacy path this repo's no-backcompat policy rules out, and it
  would keep two accounts sharing the old profile — the bug being fixed. **Release note: any
  deployment with existing browser profiles must expect to re-authenticate them once.**
- Cross-account cookie sharing closes for conversation-scoped profiles; it remains, by
  decision, for the shared default profile.
- The activity map can leak one entry when a turn marks activity and then crashes before
  finalize. Bounded by (profiles × threads) touched between finalizes and no worse than
  today's Set; accepted rather than fixed here.
- Rejected: the 4-axis queue key (repeated logins, disk per thread), plumbing the account
  through the IPC request (moves profile identity across the trust boundary), caching the
  account at session start (stale identity mid-turn, the class FENCE-1 spent four stages on),
  and failing closed on an unresolved route (a transient read would kill browsing mid-turn —
  the permanent-block class RACE-4 hit twice).
