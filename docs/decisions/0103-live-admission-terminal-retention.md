---
status: proposed
confirmed_by: ""
date: 2026-08-03
stories: [PERF-4]
---

# Live Admission Terminal Retention

## Context

Live-admission work items persist for coordination and audit, but rows in
terminal states (completed / failed / cancelled) are never deleted, so the
table grows without bound. The audit harvest (0102) shipped the size caps half
of PERF-4; retention policy for terminal rows remained an open decision:
delete on a TTL, or keep everything for audit history.

## Decision

Terminal live-admission work items are retained for **30 days**, then deleted
by a periodic maintenance sweep (run from the existing scheduled-maintenance
machinery, not a new subsystem). Non-terminal rows are never touched by the
sweep.

## Consequences

- The table is bounded while keeping a month of history for post-hoc
  debugging of admission behavior.
- Older forensic questions must be answered from logs/OTel, not this table.
- Implies one small implementation task: the sweep job plus a test proving it
  deletes only terminal rows older than the cutoff. That task completes PERF-4.
