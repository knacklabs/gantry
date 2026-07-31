---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-25
---

# Arch1 Client Signoff

## Context
`npm run check:architecture` is failing on `main`. Two files exceed their line
budgets at `c986aff4e`:

- `apps/core/src/jobs/system-jobs.ts` — 745 lines against 700, introduced by
  PR #295 (DREAM-P0)
- `apps/core/src/runtime/group-processing.ts` — 860 lines against 840, already
  fixed in open PR #296

This matters more than a style nit because `factory/scripts/verify.py` aborts at
its FIRST failing phase, and `structural` runs first. A single over-budget file
therefore masks typecheck and tests for every branch in the repo — nobody gets a
deterministic verify signal until it is fixed.

The breach went unnoticed because `check:architecture` is not part of the GitHub
CI workflow; it runs only locally inside `verify.py`. PR #296's `ci` check passed
with the `system-jobs.ts` breach already present on its base, which is the direct
evidence. That is how two breaches accumulated on `main` in a single day.

## Decision
Ravi asked for `main` to be green on 2026-07-25, after being shown that the
`system-jobs.ts` breach came from PR #295 and was deliberately left out of
PR #296 to avoid entangling an unrelated cancellation-hardening review with
another effort's file.

Split `system-jobs.ts` below its budget on a dedicated branch off `main`, as a
behaviour-neutral extraction following the existing `apps/core/src/jobs/*`
module convention. Do not ratchet the budget: the owner chose splitting over
ratcheting earlier the same day for the analogous `group-processing.ts` breach,
the 840 there was itself a ratchet from the 700 default, and D-0003 in
`plans/deferrals.md` shows ratchets accumulate.

## Consequences
- Phases at `planning` or later are unblocked for ARCH-1.
- `main` is green on this gate only once BOTH this change and PR #296 land.
  Neither alone is sufficient, and this task must not claim otherwise.
- Scope is a pure move: exports unchanged, no existing test modified, `scripts/`
  untouched. If a seam cannot satisfy that, the seam is wrong, not the constraint.
- A seam that drags `../config/**` or `../adapters/**` imports into a fresh
  sibling can expose a layer violation the original file was grandfathered for.
  That exact failure occurred on the `group-processing.ts` split earlier today and
  was re-cut rather than papered over with a new exception.
- The underlying process gap — the architecture gate being absent from CI — is
  NOT addressed here and remains open for the repo owner. See
  [[architecture-gate-not-in-ci]].
