---
status: accepted
confirmed_by: 'Suraj-Bangade'
date: 2026-08-10
stories: [E2E-2]
---

# E2E-2 API-first scope

## Context

The E2E-1 reconciliation identified section 18 of the agent E2E matrix as the
smallest next slice, while the older E2E-2 roadmap text grouped unrelated
boot, all-tools, channel, security, and recovery scenarios into one story.
The user-facing test goal prioritizes API-first, deterministic checks and
avoids long-running or speculative coverage.

## Decision

E2E-2 is bounded to the section 18 API-first slice: model catalog/default
invariants, per-turn control validation/projection, and usage reconciliation
for the existing protected Haiku lane. Cost visibility and unrelated matrix
rows remain separate deferred work with explicit reopen triggers.

## Consequences

The roadmap acceptance criteria are refined to match this slice. Tests must
reuse the existing Control API and agent-E2E harness, assert relationships and
state rather than fixed catalog snapshots or response wording, and report
protected-lane skips honestly when credentials or isolated infrastructure are
unavailable. Broad backlog rows need capability-specific follow-up stories.
