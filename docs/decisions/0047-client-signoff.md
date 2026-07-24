---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-24
---

# Client Signoff

## Context
Live testing of the shipped PERM-3 build (merged to main as `3eeb68040`) surfaced
five permission-legibility/UX gaps that PERM-3's F1–F5 scope did not cover: the
agent's own output/interaction tools (`ask_user_question`, `render_*`) get
permission-prompted; two 5-minute timeboxes still exist despite the locked
no-timebox decision; the agent cannot tell a classifier auto-allow from a
human-escalated decision (it conflated "classifier low-risk" with "allowed"); and
permission prompts carry no risk label. A rails-probe confirmed the hard-floors
are sound, so this is a legibility/birthright initiative, not a security fix.

## Decision
Ravi signed off on 2026-07-24 to proceed with PERM-4 on branch
`feat/PERM-4-permission-legibility` as a bounded initiative covering the five
requirements: (1) birthright the agent output/interaction class; (2) durable
no-timeout pause; (3) surface `decidedBy` provenance to the agent; (4) risk
label/severity on prompts; (5) lock hard-floors with tests. This sets
`client_signoff: true` in `.factory/run.json` and authorizes planning →
decomposition → implementation.

## Consequences
- Phases at `planning` or later are unblocked for PERM-4.
- Commits to the legibility direction while leaving the exact design calls
  (birthright-class boundary, provenance/label surfacing shape, job-lane durable
  pause) to the per-task plan grill — see the recorded signoff grill's six gaps.
- Scope is legibility + birthright only; the sound hard-floors and the shipped
  ladder/classifier from [[permission-holistic-redesign]] are unchanged.
