# ASKFLOOR-1-T3a task-contract grill — round 2 answer (gpt-5.6-sol @ xhigh)

1. **Protected-destination result is contradictory.** AC3 requires `{ ok: false, reason: 'protected_destination' }`, but `reviewer_focus` still says a boundary refusal returns `undefined`. Minimal fix: replace `undefined for an allow` with the exact discriminated `protected_destination` result.
2. **The workflow permits forbidden non-exact No scopes.** The diagram routes only `deny + exact` to the full hash, then routes unqualified `kind` and `place` requests to keys. AC3 and Decision 0154 require every `deny` with non-exact scope to return `deny_requires_exact`. Minimal fix: add a prior `deny + kind/place → not_rememberable: deny_requires_exact` branch and make the `kind`/`place` branches Allow-only.
3. **The full refresh set is not pinned by its leaf.** The Postgres leaf promises only newest outcome and re-encoded provenance. Minimal fix: extend that leaf title and assertions to enumerate the complete refresh set.

Non-blocking notes: the six ACs equal the six `plan_contracts`; eight leaf selectors, three Postgres; budget 16 / 22,000 and the full Postgres verify command correctly folded; write scope respects the T3a/T3b/T3c boundary; no new contradiction with 0118, 0107 or 0054.

NOT CONVERGED — three folded-contract inconsistencies remain.

## Fold (orchestrator, contract v3)

(1) `reviewer_focus` now states the discriminated `protected_destination` result; (2) the Workflow diagram gains a `deny + kind/place → deny_requires_exact` branch before the key branches, which are Allow-only; (3) the Postgres round-trip leaf enumerates the complete refresh set.
