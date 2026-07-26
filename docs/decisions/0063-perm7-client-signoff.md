---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-26
---

# Perm7 Client Signoff

## Context
A test-coverage audit of the permission system found, and the orchestrator confirmed in
source, that classifier decision-memory rows are saved with an `expires_at` but the read path
never checks it. `get`/`list` in
`permission-decision-memory-repository.postgres.ts` filter only `revokedAt IS NULL`, and the
coordinator's cache stage (`permission-decision-coordinator.ts:124-146`) trusts
`cached.decision === 'allow'` as-is. So an approval meant to lapse keeps auto-allowing forever,
silently, until revoked by hand or invalidated by a rail-version change.

Trusted-root grants do not share the defect: they pass through `isActiveGrant`
(`permission-decision-coordinator.ts:251`), which checks both `revokedAt` and `expiresAt`. The
classifier-verdict path simply never received the same check.

This is stale authority rather than an injection vector, but it undermines the design intent
that a cached verdict must not outlive the conditions under which it was issued.

## Decision
Ravi confirmed the fix on 2026-07-26 ("Yes"). Enforce expiry on the decision-memory read path
so an expired row can never produce an auto-allow, matching the semantics `isActiveGrant`
already applies to trusted-root grants. He also asked for the audit's identified missing tests
to be written; that is tracked separately (TEST-1) so this security fix ships without waiting
on a large test backlog.

## Consequences
- An expired classifier verdict falls through to the live classifier (or the human), which is
  the intended ladder.
- Enforce at the repository read, so every consumer — present and future — inherits the check
  rather than each caller remembering to apply it. This mirrors the single-choke-point rule
  applied in PERM-6.
- Expired rows become dead data; whether to prune them is a retention question, not a
  correctness one, and stays out of scope here.
