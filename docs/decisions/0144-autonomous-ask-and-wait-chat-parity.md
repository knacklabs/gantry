---
status: accepted
confirmed_by: "Ravi Kiran Vemula"
date: 2026-08-23
stories: [JOBPERM-1]
---

# Autonomous runs ask-and-wait (chat parity)

> Renumbered 0135 → 0144 when merging main (0135 was taken in parallel by the browser model-provider credential facade decision). Earlier records cite it as 0135.

## Context

Scheduled runs' tool calls that matched no grant were cancelled instantly by the
autonomous permission lane (permission-callback.ts hard-return, timeout 0) —
even when the host's own coordinator would approve (Browser) or the user was one
tap away. Live evidence on KnackLabs Lead Maintenance: "Needs permission"
dead-ends on six days in two weeks; the browser granted and prelaunched yet
unreachable; request_access itself denied; accuracy silently degraded as the
model satisficed with lesser tools. The owner mandate: jobs must never lose
accuracy because a tool was blocked — ask like chat, approve once permanently,
continue the run.

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

## Consequences

- Scheduled runs stop dead-ending on permission misses; one living approval
  card per job appears in the job's conversation; approvals resume the held
  tool call in place and persist to the job (next run silent-allows).
- The parallel autonomous permission lane is DELETED (single-cut): worker
  hard-returns, the dead classifier-wait, dual auth/timeout rules, and the
  no-grant terminal-denial re-carding loop are removed; the interactive path
  serves both lanes with rails-first deterministic fast-pathing.
- A waiting run releases its workspace slot (siblings never starve) and its
  lease clock pauses via host-monotonic pending-interval accounting; the wait
  is bounded by a 24h window anchored at confirmed card delivery, degrading to
  the durable setup-pause card (approval then re-runs the job via an explicit
  human [Approve & run again]).
- Denials are remembered per need (no re-ask across runs) with a one-tap
  Reconsider; hard-boundary shapes and unprojected tools follow the two
  owner-accepted physics limits below — accuracy loss is always visible
  ("Completed with limits"), never silent.

## Implementation

The v9 design (plans/review-briefs/scheduled-job-permission-parity-design.md,
7 adversarial review rounds) is the binding contract; the single-cut Deletions
section removes the parallel autonomous permission lane.
