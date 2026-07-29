---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-23
---

# Client Signoff

## Context
The permission-engine redesign (PERM-3) changes security-critical behavior: what
the runtime auto-allows, caches, and asks a human about. The phase contract
requires recorded client sign-off before planning, and a change of this blast
radius should not consume planning + decomposition + implementation effort until
the client has confirmed the problem framing and the intended direction. The
problem was established by a live field audit (285 asks / 198 to human / 44 to
classifier; 0 of 38 saved rules matching) showing the ~740-char host env prefix
plus 500-char truncation defeats every permission layer, and by a grill-locked
holistic design (ladder model, provenance prefix-strip, risk-only classifier).

## Decision
Ravi signed off on 2026-07-23 to proceed with the holistic permission-engine
redesign as one bounded initiative: F1 (judge the real, prefix-stripped command)
first, then the F2–F5 classifier/capability/risk heavy-lift, per the grill-locked
design. This sets `client_signoff: true` in `.factory/run.json` and authorizes the
run to advance through planning → decomposition → implementation.

## Consequences
- Phases at `planning` or later are unblocked for PERM-3.
- Commits to the direction — deterministic ladder, provenance-authenticated
  prefix stripping, and a risk-only classifier with engine-derived authorization —
  while leaving the two load-bearing technical calls to their own records:
  [[0042-decision-view-16k-prefix-stripped]] and
  [[0043-classifier-risk-only-engine-authz]].
- The sign-off covers scope and direction, not implementation detail; those are
  gated separately by the per-task plan grill and the review lenses.
