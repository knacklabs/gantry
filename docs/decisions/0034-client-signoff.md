---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-22
---

# Client Signoff

## Context

The symphony-forge harness gates phases at planning and beyond on recorded
client sign-off. This repo's client is its owner (vrknetha). The handover was
grilled at the signoff gate on 2026-07-22 (pass; 4 questions, 5 resolutions —
commit a46fdba87): BRIEF tenancy scope clarified, decision 0003 owner-state
rule sharpened, roadmap source pinned to goals-index + goal-prompts, dropped
scope ledgered as deferrals D-0001/D-0002.

## Decision

The client signs off on `docs/product/BRIEF.md`, `docs/product/DISCOVERY.md`,
and the decision corpus as the handover for harness-run delivery, with the
goals index (`docs/architecture/goals-index.md`) as the roadmap source.

## Consequences

- `record_signoff.py` flips `client_signoff` in `.factory/run.json`; planning,
  decomposition, and implementation phases unlock for forge tasks.
- The next gate is epics approval (`epics-approved` decision + epics grill)
  before `./forge roadmap import`.
- Scope changes after sign-off go through new decision records, not silent
  BRIEF edits.
