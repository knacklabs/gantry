---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-29
---

# LAT-3B Client Signoff

## Context

The client authorized the complete remaining MyClaw response-latency program in
chat on 2026-07-28, and on 2026-07-29 asked for all remaining tasks to be
completed with autoreview clean. LAT-3B is the roadmap's Phase 3B,
"Cursor-Fenced Pending Replay Reuse", on branch
`perf/phase3b-cursor-fenced-replay`.

The client also required that each phase reproduce its baseline before changing
production behavior, and that a Forge signal be raised and the plan revised —
rather than the implementation forced — if the stated problem does not hold up.

That is exactly what happened. Signal `S-0001-8b22` (contradiction) was raised
and resolved before planning. The double fetch reproduces, but its premise does
not: the second fetch costs one repository call and one SQL statement per turn,
and reusing the admission snapshot would drop inbound messages arriving mid-turn
because the queue cursor advances on consumption rather than arrival. The
evidence and reasoning are recorded in
`docs/decisions/0080-lat-3b-retain-authoritative-second-fetch.md`.

## Decision

Proceed with LAT-3B as a REVISED, measurement-closing phase rather than an
optimization phase.

LAT-3B authorizes: the decision record rejecting replay reuse; corrections to
the roadmap's Phase 3B entry and the goal prompt's A3 section so the wrong
remedy is not rediscovered; and a durable regression test that pins the
two-fetch contract and the second fetch's operation count so the idea cannot
return without new evidence.

LAT-3B does NOT authorize any production behavior change. No reuse, no new
payload field, no cursor-fence machinery, no cache.

## Consequences

Phase 3B is closed by measurement and joins job latest-run batching and IPC
replay cleanup in the roadmap's Closed/Measurement-Gated section.

The task is not PR-ready until the regression test passes, deterministic verify
passes, one branch-closeout three-lens autoreview is clean, and CI is green.
Merging remains human-gated. Phase 4A does not start until LAT-3B is merged.
