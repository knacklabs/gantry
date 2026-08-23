---
status: accepted
confirmed_by: "Ravi Kiran Vemula"
date: 2026-08-23
stories: [JOBPERM-1]
---

# Autonomous runs ask-and-wait (chat parity)

## Decision

A scheduled (autonomous) run whose tool call matches no grant ASKS the user via
the standard in-channel approval card, holds the tool call in the shared wait
loop, resumes in place on an authorized Allow, and persists the approval to the
job (permanent; no Allow-once). Explicit Deny remains a typed terminal denial
per need with user-initiated Reconsider. Absence-of-grant no longer cancels.

## Supersedes / amends

- 0121: deterministic decisions stand and the classifier stays interactive-only;
  the no-match OUTCOME changes from cancel to ask-with-listener.
- 0115/0126: typed terminal denial semantics now apply to EXPLICIT denials and
  to the degraded handoff path (setup-pause), not to grant misses.
- 0053/0056/0106/0118/0124 are relied upon unchanged.

## Physics limits (owner-accepted)

1. Remote-content-execution shapes (pipes, destructive redirects, inline
   interpreters, download-then-execute across calls) are reformulation-only —
   never permanently grantable.
2. Tools granted mid-run but unloadable in-session land next run: the run ends
   "Completed with limits" with a human-only Run-again; no automatic rerun
   after partial work anywhere.

## Implementation

The v9 design (plans/review-briefs/scheduled-job-permission-parity-design.md,
7 adversarial review rounds) is the binding contract; the single-cut Deletions
section removes the parallel autonomous permission lane.
