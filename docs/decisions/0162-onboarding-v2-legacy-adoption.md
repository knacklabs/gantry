---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-14
stories: [ONBOARDING-V2-1, ONBOARD-UI-1]
---

# V2 onboarding legacy adoption boundary

## Context

The V2 first-agent onboarding implementation was completed on the local
`feat/v2-onboarding` archive before this repository adopted the current
task-per-PR Forge process. It contains a cohesive first-run experience,
including browser-safe credential setup, resumable state, Slack manifest
guidance, and verified readiness. The archive must be preserved as evidence,
not rewritten or pushed as a substitute for a reviewable Forge task.

`ONBOARD-UI-1` remains a dependency-bound roadmap story for the broader V1
wizard. Treating the V2 archive as its completion would incorrectly declare
future Console and platform dependencies delivered.

## Decision

Adopt the V2 archive as one bounded legacy task, `ONBOARDING-V2-1-T1`, on a
new Forge task branch created from current `origin/main`. Transplant the source
delta from the recorded base commit through the archive tip, excluding stale
`.factory` state, then verify and review it under the normal task gates.

`ONBOARD-UI-1` is not completed, superseded, or modified by this adoption. It
continues to own the future dependency-bound wizard scope; this story owns only
the reviewable V2 first-run implementation already present in the archive.

## Consequences

- The task branch is the only future V2 review branch; the archive remains
  untouched and unpushed.
- The adoption records the one-time legacy exception in its plan and covers the
  whole transplanted delta in one task because the historic commits are
  interleaved and cannot be safely re-split without rewriting history.
- No Forge or factory script changes are needed. Existing recorders, tests,
  review, and functional checks remain the source of PR evidence.
